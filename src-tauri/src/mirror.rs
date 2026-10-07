use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderMap, HeaderValue, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use futures_util::{SinkExt, StreamExt};
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::service::TowerToHyperService;
use rcgen::{
    BasicConstraints, CertificateParams, CidrSubnet, DnType, ExtendedKeyUsagePurpose,
    GeneralSubtree, IsCa, Issuer, KeyPair, KeyUsagePurpose, NameConstraints,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, watch, Semaphore};
use tokio_rustls::rustls::{self, pki_types::PrivatePkcs8KeyDer};
use tokio_rustls::TlsAcceptor;

const MAX_MESSAGE_BYTES: usize = 256 * 1024;
const PAIR_WINDOW: Duration = Duration::from_secs(60);
const COOKIE_NAME: &str = "__Host-studyvis-mirror";
const PASSWORD_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_CONNECTIONS: usize = 32;

pub struct MirrorAsset {
    pub bytes: Vec<u8>,
    pub mime_type: String,
}

pub enum MirrorEvent {
    Client { client_id: String, connected: bool },
    Message { client_id: String, data: String },
}

type AssetProvider = Arc<dyn Fn(&str) -> Option<MirrorAsset> + Send + Sync>;
type EventConsumer = Arc<dyn Fn(MirrorEvent) + Send + Sync>;

pub struct MirrorServerOptions {
    pub certificate_dir: PathBuf,
    pub addresses: Vec<Ipv4Addr>,
    pub asset: AssetProvider,
    pub on_event: EventConsumer,
    pub lease: Duration,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorConfig {
    pub urls: Vec<String>,
    pub password: String,
    pub fingerprint: String,
    pub certificate_url: String,
    pub expires_at: u64,
    pub generation: String,
}

struct Controller {
    token: String,
    client_id: String,
    connection_id: Option<String>,
    socket_revision: u64,
    outgoing: Option<mpsc::Sender<String>>,
    close: Option<watch::Sender<u16>>,
}

struct Attempts {
    since: Instant,
    total: u8,
    by_ip: HashMap<IpAddr, u8>,
}

impl Attempts {
    fn new() -> Self {
        Self {
            since: Instant::now(),
            total: 0,
            by_ip: HashMap::new(),
        }
    }

    fn allow(&mut self, ip: IpAddr, now: Instant) -> bool {
        if now.duration_since(self.since) >= PAIR_WINDOW {
            self.since = now;
            self.total = 0;
            self.by_ip.clear();
        }
        if self.total >= 10 || self.by_ip.get(&ip).copied().unwrap_or(0) >= 5 {
            return false;
        }
        self.total += 1;
        *self.by_ip.entry(ip).or_default() += 1;
        true
    }
}

struct Shared {
    active: AtomicBool,
    deadline: Instant,
    password: String,
    hosts: HashSet<String>,
    bootstrap_hosts: HashSet<String>,
    certificate: Vec<u8>,
    asset: AssetProvider,
    on_event: EventConsumer,
    controller: Mutex<Option<Controller>>,
    attempts: Mutex<Attempts>,
    shutdown: watch::Sender<bool>,
}

impl Shared {
    fn active(&self) -> bool {
        self.active.load(Ordering::Acquire) && Instant::now() < self.deadline
    }

    fn stop(&self) {
        if !self.active.swap(false, Ordering::AcqRel) {
            return;
        }
        let _ = self.shutdown.send(true);
        if let Some(controller) = self.controller.lock().unwrap().take() {
            if let Some(close) = controller.close {
                let _ = close.send(1001);
            }
            if let Some(connection_id) = controller.connection_id {
                (self.on_event)(MirrorEvent::Client {
                    client_id: connection_id,
                    connected: false,
                });
            }
        }
    }

    fn authenticated_client(&self, headers: &HeaderMap) -> Option<String> {
        let token = cookie_token(headers)?;
        let controller = self.controller.lock().unwrap();
        controller
            .as_ref()
            .filter(|c| constant_equal(token.as_bytes(), c.token.as_bytes()))
            .map(|c| c.client_id.clone())
    }
}

pub struct MirrorServer {
    config: MirrorConfig,
    shared: Arc<Shared>,
    listeners: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

pub struct MirrorSender {
    outgoing: mpsc::Sender<String>,
    shared: Arc<Shared>,
}

impl MirrorSender {
    pub async fn send(&self, data: String) -> Result<(), String> {
        if !self.shared.active() {
            return Err("browser access has ended".into());
        }
        if data.len() > MAX_MESSAGE_BYTES {
            return Err("browser message is too large".into());
        }
        match tokio::time::timeout(Duration::from_secs(5), self.outgoing.send(data)).await {
            Ok(Ok(())) => Ok(()),
            _ => Err("browser controller is busy or disconnected".into()),
        }
    }
}

impl MirrorServer {
    pub async fn start(mut options: MirrorServerOptions) -> Result<Self, String> {
        options.addresses.retain(|ip| private_ipv4(*ip));
        options
            .addresses
            .sort_by_key(|ip| (ip.is_loopback(), ip.octets()));
        options.addresses.dedup();
        if options.addresses.is_empty() {
            return Err("no private network address is available".into());
        }
        if options.lease.is_zero() || options.lease > Duration::from_secs(12 * 60 * 60) {
            return Err("invalid browser access lifetime".into());
        }
        let certificates = load_certificates(&options.certificate_dir, &options.addresses)?;
        let ports_path = options.certificate_dir.join("ports.json");
        let saved_ports = if ports_path.exists() {
            Some(
                serde_json::from_slice::<SavedPorts>(
                    &fs::read(&ports_path).map_err(|_| "couldn't read the browser ports")?,
                )
                .map_err(|_| "the saved browser ports are unreadable")?,
            )
        } else {
            None
        };
        if saved_ports
            .as_ref()
            .is_some_and(|p| p.https == 0 || p.certificate == 0 || p.https == p.certificate)
        {
            return Err("the saved browser ports are invalid".into());
        }
        let listener = bind_listener(saved_ports.as_ref().map_or(0, |p| p.https)).await?;
        let bootstrap = bind_listener(saved_ports.as_ref().map_or(0, |p| p.certificate)).await?;
        let port = listener
            .local_addr()
            .map_err(|_| "couldn't read the local port")?
            .port();
        let bootstrap_port = bootstrap
            .local_addr()
            .map_err(|_| "couldn't read the certificate port")?
            .port();
        if saved_ports.is_none() {
            write_private_new(
                &ports_path,
                &serde_json::to_vec(&SavedPorts {
                    https: port,
                    certificate: bootstrap_port,
                })
                .map_err(|_| "couldn't prepare browser ports")?,
            )?;
        }
        let hosts: HashSet<_> = options
            .addresses
            .iter()
            .map(|ip| format!("{ip}:{port}"))
            .collect();
        let bootstrap_hosts = options
            .addresses
            .iter()
            .map(|ip| format!("{ip}:{bootstrap_port}"))
            .collect();
        let password = random_password()?;
        let (shutdown, _) = watch::channel(false);
        let shared = Arc::new(Shared {
            active: AtomicBool::new(true),
            deadline: Instant::now() + options.lease,
            password: password.clone(),
            hosts,
            bootstrap_hosts,
            certificate: certificates.root.clone(),
            asset: options.asset,
            on_event: options.on_event,
            controller: Mutex::new(None),
            attempts: Mutex::new(Attempts::new()),
            shutdown,
        });
        let config = MirrorConfig {
            urls: options
                .addresses
                .iter()
                .map(|ip| format!("https://{ip}:{port}"))
                .collect(),
            password,
            fingerprint: hex::encode(Sha256::digest(&certificates.root))
                .as_bytes()
                .chunks(2)
                .map(|b| std::str::from_utf8(b).unwrap())
                .collect::<Vec<_>>()
                .join(":"),
            certificate_url: format!(
                "http://{}:{bootstrap_port}/certificate.crt",
                options.addresses[0]
            ),
            expires_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "the system clock is invalid")?
                .as_millis() as u64
                + options.lease.as_millis() as u64,
            generation: random_hex(16)?,
        };
        let provider = rustls::crypto::ring::default_provider();
        let mut tls = rustls::ServerConfig::builder_with_provider(Arc::new(provider))
            .with_safe_default_protocol_versions()
            .map_err(|_| "couldn't configure TLS")?
            .with_no_client_auth()
            .with_single_cert(
                vec![certificates.leaf.into(), certificates.root.into()],
                PrivatePkcs8KeyDer::from(certificates.key).into(),
            )
            .map_err(|_| "couldn't load the local TLS certificate")?;
        tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        let router = Router::new()
            .route("/api/pair", post(pair))
            .route("/api/status", get(status))
            .route("/api/socket", get(socket))
            .fallback(asset)
            .layer(DefaultBodyLimit::max(1024))
            .layer(middleware::from_fn_with_state(
                shared.clone(),
                secure_boundary,
            ))
            .with_state(shared.clone());
        let https_task = tokio::spawn(serve(
            listener,
            Some(TlsAcceptor::from(Arc::new(tls))),
            router,
            shared.clone(),
        ));
        let bootstrap_router = Router::new()
            .route("/certificate.crt", get(certificate))
            .layer(middleware::from_fn_with_state(
                shared.clone(),
                bootstrap_boundary,
            ))
            .with_state(shared.clone());
        let bootstrap_task = tokio::spawn(serve(bootstrap, None, bootstrap_router, shared.clone()));
        let expiry = shared.clone();
        tokio::spawn(async move {
            let mut shutdown = expiry.shutdown.subscribe();
            if *shutdown.borrow() {
                return;
            }
            tokio::select! {
                _ = tokio::time::sleep(options.lease) => expiry.stop(),
                _ = shutdown.changed() => {},
            }
        });
        Ok(Self {
            config,
            shared,
            listeners: Mutex::new(vec![https_task, bootstrap_task]),
        })
    }

    pub fn config(&self) -> &MirrorConfig {
        &self.config
    }

    pub async fn send(&self, client_id: &str, data: String) -> Result<(), String> {
        self.sender(client_id)?.send(data).await
    }

    pub fn sender(&self, client_id: &str) -> Result<MirrorSender, String> {
        if !self.shared.active() {
            return Err("browser access has ended".into());
        }
        let controller = self.shared.controller.lock().unwrap();
        let controller = controller
            .as_ref()
            .filter(|c| c.connection_id.as_deref() == Some(client_id))
            .ok_or("browser controller is unavailable")?;
        let outgoing = controller
            .outgoing
            .as_ref()
            .ok_or("browser controller is disconnected")?
            .clone();
        Ok(MirrorSender {
            outgoing,
            shared: self.shared.clone(),
        })
    }

    pub fn stop(&self) {
        self.shared.stop();
    }

    pub async fn shutdown(&self) {
        self.stop();
        let listeners = std::mem::take(&mut *self.listeners.lock().unwrap());
        for listener in listeners {
            let _ = listener.await;
        }
    }
}

impl Drop for MirrorServer {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn bind_listener(port: u16) -> Result<TcpListener, String> {
    for attempt in 0..40 {
        match TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).await {
            Ok(listener) => return Ok(listener),
            Err(error)
                if port != 0 && error.kind() == std::io::ErrorKind::AddrInUse && attempt < 39 =>
            {
                // Stop wakes the accept task; allow it to release the stable port.
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                return Err("the browser access port is already in use".into())
            }
            Err(_) => return Err("couldn't listen on the local network".into()),
        }
    }
    Err("the browser access port is already in use".into())
}

async fn serve(
    listener: TcpListener,
    tls: Option<TlsAcceptor>,
    router: Router,
    shared: Arc<Shared>,
) {
    let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let mut shutdown = shared.shutdown.subscribe();
    if *shutdown.borrow() || !shared.active() {
        return;
    }
    loop {
        let accepted = tokio::select! {
            _ = shutdown.changed() => break,
            accepted = listener.accept() => accepted,
        };
        let Ok((stream, remote)) = accepted else {
            shared.stop();
            break;
        };
        if !private_source(remote.ip()) || !shared.active() {
            continue;
        }
        let Ok(permit) = permits.clone().try_acquire_owned() else {
            continue;
        };
        let tls = tls.clone();
        let service = TowerToHyperService::new(router.clone().layer(Extension(remote)));
        let mut close = shared.shutdown.subscribe();
        tokio::spawn(async move {
            let _permit = permit;
            if *close.borrow() {
                return;
            }
            if let Some(tls) = tls {
                let accepted = tokio::select! {
                    _ = close.changed() => return,
                    accepted = tokio::time::timeout(Duration::from_secs(10), tls.accept(stream)) => accepted,
                };
                let Ok(Ok(stream)) = accepted else {
                    return;
                };
                let builder = hyper_util::server::conn::auto::Builder::new(TokioExecutor::new());
                tokio::select! {
                    _ = close.changed() => {},
                    _ = tokio::time::timeout(Duration::from_secs(30), builder.serve_connection_with_upgrades(TokioIo::new(stream), service)) => {},
                }
            } else {
                let builder = hyper_util::server::conn::auto::Builder::new(TokioExecutor::new());
                tokio::select! {
                    _ = close.changed() => {},
                    _ = tokio::time::timeout(Duration::from_secs(15), builder.serve_connection_with_upgrades(TokioIo::new(stream), service)) => {},
                }
            }
        });
    }
}

fn host_allowed(headers: &HeaderMap, hosts: &HashSet<String>) -> bool {
    headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|host| hosts.contains(host))
}

fn origin_allowed(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|origin| origin == format!("https://{host}"))
}

async fn secure_boundary(
    State(shared): State<Arc<Shared>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if !shared.active() {
        return StatusCode::GONE.into_response();
    }
    if !host_allowed(request.headers(), &shared.hosts) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if request.uri().path().starts_with("/api/") {
        let origin_required = request.uri().path() != "/api/status";
        if origin_required && !origin_allowed(request.headers()) {
            return StatusCode::FORBIDDEN.into_response();
        }
        if let Some(origin) = request.headers().get(header::ORIGIN) {
            if origin.to_str().is_err() || !origin_allowed(request.headers()) {
                return StatusCode::FORBIDDEN.into_response();
            }
        }
    }
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap()
        .to_string();
    let mut response = next.run(request).await;
    for (name, value) in [
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("cache-control", "no-store"),
        (
            "permissions-policy",
            "camera=(self), microphone=(self), display-capture=(self), geolocation=()",
        ),
    ] {
        response
            .headers_mut()
            .insert(name, HeaderValue::from_static(value));
    }
    let csp = format!("default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' wss://{host}; worker-src 'self'; form-action 'self'");
    response.headers_mut().insert(
        "content-security-policy",
        HeaderValue::from_str(&csp).unwrap(),
    );
    response
}

async fn bootstrap_boundary(
    State(shared): State<Arc<Shared>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if !shared.active() {
        return StatusCode::GONE.into_response();
    }
    if !host_allowed(request.headers(), &shared.bootstrap_hosts) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
}

async fn certificate(State(shared): State<Arc<Shared>>) -> Response {
    (
        [
            (header::CONTENT_TYPE, "application/x-x509-ca-cert"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=StudyVis-LAN.crt",
            ),
        ],
        shared.certificate.clone(),
    )
        .into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PairRequest {
    password: String,
}

async fn pair(
    State(shared): State<Arc<Shared>>,
    Extension(remote): Extension<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<PairRequest>,
) -> Response {
    if let Some(client_id) = shared.authenticated_client(&headers) {
        return Json(serde_json::json!({"clientId": client_id})).into_response();
    }
    if !shared
        .attempts
        .lock()
        .unwrap()
        .allow(remote.ip(), Instant::now())
    {
        return (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "60")]).into_response();
    }
    if !constant_equal(request.password.as_bytes(), shared.password.as_bytes()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(token) = random_hex(32) else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let Ok(client_id) = random_hex(16) else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let mut controller = shared.controller.lock().unwrap();
    if controller.is_some() {
        return StatusCode::CONFLICT.into_response();
    }
    *controller = Some(Controller {
        token: token.clone(),
        client_id: client_id.clone(),
        connection_id: None,
        socket_revision: 0,
        outgoing: None,
        close: None,
    });
    let cookie =
        format!("{COOKIE_NAME}={token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=43200");
    let mut response = Json(serde_json::json!({"clientId": client_id})).into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
    response
}

async fn status(State(shared): State<Arc<Shared>>, headers: HeaderMap) -> Response {
    match shared.authenticated_client(&headers) {
        Some(client_id) => Json(serde_json::json!({"clientId": client_id})).into_response(),
        None => StatusCode::UNAUTHORIZED.into_response(),
    }
}

async fn socket(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(client_id) = shared.authenticated_client(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    ws.max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| connected(socket, shared, client_id))
        .into_response()
}

async fn connected(socket: WebSocket, shared: Arc<Shared>, client_id: String) {
    let Ok(connection_id) = random_hex(16) else {
        return;
    };
    let (outgoing, mut receive) = mpsc::channel::<String>(32);
    let (close, mut closed) = watch::channel(0u16);
    let revision = {
        let mut controller = shared.controller.lock().unwrap();
        let Some(controller) = controller.as_mut().filter(|c| c.client_id == client_id) else {
            return;
        };
        if !shared.active() {
            return;
        }
        if let Some(previous) = controller.close.take() {
            let _ = previous.send(4001);
        }
        if let Some(previous_id) = controller.connection_id.take() {
            (shared.on_event)(MirrorEvent::Client {
                client_id: previous_id,
                connected: false,
            });
        }
        controller.socket_revision += 1;
        controller.connection_id = Some(connection_id.clone());
        controller.outgoing = Some(outgoing);
        controller.close = Some(close);
        (shared.on_event)(MirrorEvent::Client {
            client_id: connection_id.clone(),
            connected: true,
        });
        controller.socket_revision
    };
    let (mut sink, mut source) = socket.split();
    let mut shutdown = shared.shutdown.subscribe();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
    let mut last_pong = Instant::now();
    let mut message_window = Instant::now();
    let mut message_count = 0;
    let mut message_bytes = 0;
    let mut close_code = 1000;
    loop {
        tokio::select! {
            _ = shutdown.changed() => { close_code = 1001; break; },
            _ = closed.changed() => { close_code = *closed.borrow(); break; },
            data = receive.recv() => {
                let Some(data) = data else { break; };
                if !matches!(tokio::time::timeout(Duration::from_secs(5), sink.send(Message::Text(data.into()))).await, Ok(Ok(()))) { break; }
            },
            message = source.next() => {
                match message {
                    Some(Ok(Message::Text(data))) => {
                        let controller = shared.controller.lock().unwrap();
                        if !shared.active() || !controller.as_ref().is_some_and(|c| c.socket_revision == revision && c.connection_id.as_deref() == Some(&connection_id)) { break; }
                        if message_window.elapsed() >= Duration::from_secs(1) { message_window = Instant::now(); message_count = 0; message_bytes = 0; }
                        message_count += 1;
                        message_bytes += data.len();
                        if message_count > 512 || message_bytes > 16 * 1024 * 1024 { break; }
                        (shared.on_event)(MirrorEvent::Message { client_id: connection_id.clone(), data: data.to_string() });
                    },
                    Some(Ok(Message::Pong(_))) => last_pong = Instant::now(),
                    Some(Ok(Message::Ping(_))) => {},
                    _ => break,
                }
            },
            _ = heartbeat.tick() => {
                if last_pong.elapsed() > Duration::from_secs(45) { break; }
                if !matches!(tokio::time::timeout(Duration::from_secs(5), sink.send(Message::Ping(Vec::new().into()))).await, Ok(Ok(()))) { break; }
            },
        }
    }
    // Replacing the controller also drops its outgoing sender. That wake-up
    // can win the select before the close signal, but the reason still applies.
    let requested_close = *closed.borrow();
    if requested_close != 0 {
        close_code = requested_close;
    }
    let reason = match close_code {
        4001 => "controller replaced",
        1001 => "browser access ended",
        _ => "connection ended",
    };
    let _ = tokio::time::timeout(
        Duration::from_secs(1),
        sink.send(Message::Close(Some(CloseFrame {
            code: close_code,
            reason: reason.into(),
        }))),
    )
    .await;
    let disconnected = {
        let mut controller = shared.controller.lock().unwrap();
        controller
            .as_mut()
            .filter(|c| c.client_id == client_id && c.socket_revision == revision)
            .map(|c| {
                c.outgoing = None;
                c.close = None;
                c.connection_id = None;
            })
            .is_some()
    };
    if disconnected {
        (shared.on_event)(MirrorEvent::Client {
            client_id: connection_id,
            connected: false,
        });
    }
}

fn cookie_token(headers: &HeaderMap) -> Option<&str> {
    let cookies = headers.get(header::COOKIE)?.to_str().ok()?;
    let mut found = cookies
        .split(';')
        .filter_map(|cookie| cookie.trim().split_once('='))
        .filter(|(name, _)| *name == COOKIE_NAME);
    let (_, token) = found.next()?;
    if found.next().is_some() || token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return None;
    }
    Some(token)
}

async fn asset(State(shared): State<Arc<Shared>>, request: Request<Body>) -> Response {
    if request.method() != axum::http::Method::GET && request.method() != axum::http::Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let Some(path) = allowed_asset_path(request.uri().path()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(asset) = (shared.asset)(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Tauri's asset resolver can fall back to its main index for unknown paths.
    if path != "mirror.html" && asset.mime_type.contains("text/html") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Ok(mime) = HeaderValue::from_str(&asset.mime_type) else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let mut response = if request.method() == axum::http::Method::HEAD {
        Body::empty().into_response()
    } else {
        asset.bytes.into_response()
    };
    response.headers_mut().insert(header::CONTENT_TYPE, mime);
    response
}

pub fn allowed_asset_path(path: &str) -> Option<String> {
    if path == "/" || path == "/mirror.html" {
        return Some("mirror.html".into());
    }
    if matches!(
        path,
        "/mirror-sw.js" | "/manifest.webmanifest" | "/mirror-icon.svg" | "/mirror-icon.png"
    ) {
        return Some(path[1..].into());
    }
    if !path.starts_with("/assets/")
        || path.ends_with(".map")
        || path.contains('%')
        || path.contains('\\')
    {
        return None;
    }
    if path.split('/').skip(1).any(|segment| {
        segment.is_empty()
            || segment == "."
            || segment == ".."
            || !segment
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    }) {
        return None;
    }
    Some(path[1..].into())
}

pub fn private_ipv4(ip: Ipv4Addr) -> bool {
    ip.is_private() || ip.is_loopback()
}
fn private_source(ip: IpAddr) -> bool {
    matches!(ip, IpAddr::V4(ip) if private_ipv4(ip))
}

pub fn local_addresses() -> Result<Vec<Ipv4Addr>, String> {
    let mut addresses: Vec<_> = if_addrs::get_if_addrs()
        .map_err(|_| "couldn't find the local network")?
        .into_iter()
        .filter_map(|interface| match interface.ip() {
            IpAddr::V4(ip) if private_ipv4(ip) && !ip.is_loopback() => Some(ip),
            _ => None,
        })
        .collect();
    addresses.sort();
    addresses.dedup();
    addresses.push(Ipv4Addr::LOCALHOST);
    Ok(addresses)
}

fn constant_equal(a: &[u8], b: &[u8]) -> bool {
    bool::from(a.ct_eq(b))
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut random = vec![0; bytes];
    getrandom::fill(&mut random).map_err(|_| "secure random data is unavailable")?;
    Ok(hex::encode(random))
}

fn random_password() -> Result<String, String> {
    let mut random = [0; 8];
    getrandom::fill(&mut random).map_err(|_| "secure random data is unavailable")?;
    Ok(random
        .into_iter()
        .map(|b| PASSWORD_ALPHABET[(b & 31) as usize] as char)
        .collect())
}

struct Certificates {
    root: Vec<u8>,
    leaf: Vec<u8>,
    key: Vec<u8>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SavedPorts {
    https: u16,
    certificate: u16,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredLeaf {
    addresses: Vec<Ipv4Addr>,
    certificate: Vec<u8>,
    key: Vec<u8>,
    renew_after: i64,
}

fn load_certificates(directory: &Path, addresses: &[Ipv4Addr]) -> Result<Certificates, String> {
    fs::create_dir_all(directory).map_err(|_| "couldn't create local certificate storage")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| "couldn't protect local certificate storage")?;
    }
    let root_path = directory.join("root.crt");
    let root_key_path = directory.join("root-key.pem");
    #[cfg(windows)]
    {
        protect_windows_certificate_path(directory)?;
        for file in ["root.crt", "root-key.pem", "server.json", "ports.json"] {
            let path = directory.join(file);
            if path.exists() {
                protect_windows_certificate_path(&path)?;
            }
        }
    }
    let (root, issuer) = if root_path.exists() || root_key_path.exists() {
        let root = fs::read(&root_path).map_err(|_| "couldn't read the local certificate")?;
        let key = fs::read_to_string(&root_key_path)
            .map_err(|_| "couldn't read the local certificate key")?;
        let key = KeyPair::from_pem(&key).map_err(|_| "the local certificate key is unreadable")?;
        let issuer = Issuer::from_ca_cert_der(&root.clone().into(), key)
            .map_err(|_| "the local certificate is unreadable")?;
        (root, issuer)
    } else {
        let mut params = CertificateParams::new(Vec::new())
            .map_err(|_| "couldn't prepare the local certificate")?;
        params.distinguished_name.push(
            DnType::CommonName,
            "StudyVis local browser certificate authority",
        );
        params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        params.not_before = time::OffsetDateTime::now_utc() - time::Duration::days(1);
        params.not_after = time::OffsetDateTime::now_utc() + time::Duration::days(3650);
        params.name_constraints = Some(NameConstraints {
            permitted_subtrees: [
                "10.0.0.0/8",
                "172.16.0.0/12",
                "192.168.0.0/16",
                "127.0.0.0/8",
            ]
            .into_iter()
            .map(|range| GeneralSubtree::IpAddress(range.parse::<CidrSubnet>().unwrap()))
            .collect(),
            excluded_subtrees: vec![GeneralSubtree::DnsName("".into())],
        });
        let key = KeyPair::generate().map_err(|_| "couldn't generate the local certificate key")?;
        let cert = params
            .self_signed(&key)
            .map_err(|_| "couldn't generate the local certificate")?;
        let root = cert.der().to_vec();
        write_private_new(&root_key_path, key.serialize_pem().as_bytes())?;
        if let Err(error) = write_private_new(&root_path, &root) {
            let _ = fs::remove_file(&root_key_path);
            return Err(error);
        }
        (root, Issuer::new(params, key))
    };
    let leaf_path = directory.join("server.json");
    if leaf_path.exists() {
        let bytes =
            fs::read(&leaf_path).map_err(|_| "couldn't read the local server certificate")?;
        let saved: StoredLeaf = serde_json::from_slice(&bytes)
            .map_err(|_| "the local server certificate is unreadable")?;
        if saved.addresses == addresses
            && saved.renew_after > time::OffsetDateTime::now_utc().unix_timestamp()
            && leaf_identifies_issuer(&root, &saved.certificate)
        {
            return Ok(Certificates {
                root,
                leaf: saved.certificate,
                key: saved.key,
            });
        }
    }
    let mut leaf = CertificateParams::new(
        addresses
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
    )
    .map_err(|_| "couldn't prepare the local server certificate")?;
    leaf.distinguished_name
        .push(DnType::CommonName, "StudyVis browser companion server");
    leaf.use_authority_key_identifier_extension = true;
    leaf.not_before = time::OffsetDateTime::now_utc() - time::Duration::days(1);
    // Keep locally trusted server certificates within Apple's validity limits.
    leaf.not_after = time::OffsetDateTime::now_utc() + time::Duration::days(365);
    leaf.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    leaf.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let key = KeyPair::generate().map_err(|_| "couldn't generate the local server key")?;
    let cert = leaf
        .signed_by(&key, &issuer)
        .map_err(|_| "couldn't sign the local server certificate")?;
    let stored = StoredLeaf {
        addresses: addresses.to_vec(),
        certificate: cert.der().to_vec(),
        key: key.serialize_der(),
        renew_after: (time::OffsetDateTime::now_utc() + time::Duration::days(335)).unix_timestamp(),
    };
    let bytes =
        serde_json::to_vec(&stored).map_err(|_| "couldn't prepare the local server certificate")?;
    write_private_replace(&leaf_path, &bytes)?;
    Ok(Certificates {
        root,
        leaf: stored.certificate,
        key: stored.key,
    })
}

fn leaf_identifies_issuer(root: &[u8], leaf: &[u8]) -> bool {
    use x509_parser::{extensions::ParsedExtension, parse_x509_certificate};

    let (Ok((root_tail, root)), Ok((leaf_tail, leaf))) =
        (parse_x509_certificate(root), parse_x509_certificate(leaf))
    else {
        return false;
    };
    // Legacy leaves shared the CA's subject and omitted AKI, so OpenSSL
    // classified them as self-signed instead of building the trusted chain.
    if !root_tail.is_empty()
        || !leaf_tail.is_empty()
        || leaf.subject() == leaf.issuer()
        || leaf.issuer() != root.subject()
    {
        return false;
    }
    let root_id = root.extensions().iter().find_map(|extension| {
        if let ParsedExtension::SubjectKeyIdentifier(id) = extension.parsed_extension() {
            Some(id.0)
        } else {
            None
        }
    });
    let issuer_id = leaf.extensions().iter().find_map(|extension| {
        if let ParsedExtension::AuthorityKeyIdentifier(id) = extension.parsed_extension() {
            id.key_identifier.as_ref().map(|id| id.0)
        } else {
            None
        }
    });
    matches!((root_id, issuer_id), (Some(root), Some(issuer)) if root == issuer)
}

fn write_private_replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", random_hex(8)?));
    write_private_new(&temporary, bytes)?;
    if fs::rename(&temporary, path).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err("couldn't install the local certificate file".into());
    }
    Ok(())
}

fn write_private_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "couldn't create the local certificate file")?;
    #[cfg(windows)]
    if let Err(error) = protect_windows_certificate_path(path) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(error);
    }
    if file.write_all(bytes).and_then(|_| file.sync_all()).is_err() {
        drop(file);
        let _ = fs::remove_file(path);
        return Err("couldn't save the local certificate file".into());
    }
    Ok(())
}

#[cfg(windows)]
fn protect_windows_certificate_path(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        GetSecurityDescriptorDacl, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    };

    // Inherited AppData permissions can be broadened by an administrator.
    // The trusted CA key must remain restricted to its owner and system admins.
    let sddl: Vec<u16> = "D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut name: Vec<u16> = path.as_os_str().encode_wide().collect();
    if name.contains(&0) {
        return Err("the local certificate path is invalid".into());
    }
    name.push(0);
    let mut descriptor = ptr::null_mut();
    let mut dacl = ptr::null_mut();
    let mut present = 0;
    let mut defaulted = 0;
    // Windows allocates this descriptor; all paths after conversion release it.
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            ptr::null_mut(),
        ) == 0
        {
            return Err("couldn't prepare local certificate permissions".into());
        }
        let readable =
            GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) != 0
                && present != 0
                && !dacl.is_null();
        let protected = readable
            && SetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                dacl,
                ptr::null_mut(),
            ) == 0;
        LocalFree(descriptor);
        if !protected {
            return Err("couldn't protect local certificate storage".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_public_networks_and_asset_traversal() {
        assert!(private_ipv4(Ipv4Addr::new(192, 168, 1, 2)));
        assert!(private_ipv4(Ipv4Addr::LOCALHOST));
        assert!(!private_ipv4(Ipv4Addr::new(8, 8, 8, 8)));
        for path in ["/", "/assets/mirror-abc.js", "/mirror-sw.js"] {
            assert!(allowed_asset_path(path).is_some());
        }
        for path in [
            "/index.html",
            "/ai-dialog.html",
            "/assets/../index.html",
            "/assets/a.map",
            "/assets/%2e%2e/key.pem",
            "/root-key.pem",
        ] {
            assert!(allowed_asset_path(path).is_none(), "{path}");
        }
    }

    #[test]
    fn limits_pairing_globally_and_per_address() {
        let mut attempts = Attempts::new();
        let now = Instant::now();
        for _ in 0..5 {
            assert!(attempts.allow(Ipv4Addr::LOCALHOST.into(), now));
        }
        assert!(!attempts.allow(Ipv4Addr::LOCALHOST.into(), now));
        for last in 1..=5 {
            assert!(attempts.allow(Ipv4Addr::new(192, 168, 1, last).into(), now));
        }
        assert!(!attempts.allow(Ipv4Addr::new(10, 0, 0, 1).into(), now));
        assert!(attempts.allow(Ipv4Addr::LOCALHOST.into(), now + PAIR_WINDOW));
    }

    #[test]
    fn validates_exact_host_origin_and_cookie() {
        let mut headers = HeaderMap::new();
        let hosts = ["127.0.0.1:1234".to_string()].into_iter().collect();
        headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:1234"));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://127.0.0.1:1234"),
        );
        assert!(host_allowed(&headers, &hosts));
        assert!(origin_allowed(&headers));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://evil.example"),
        );
        assert!(!origin_allowed(&headers));
        headers.insert(header::HOST, HeaderValue::from_static("localhost:1234"));
        assert!(!host_allowed(&headers, &hosts));
        let cookie = format!("{COOKIE_NAME}={}", "a".repeat(64));
        headers.insert(header::COOKIE, HeaderValue::from_str(&cookie).unwrap());
        assert!(cookie_token(&headers).is_some());
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("{cookie}; {cookie}")).unwrap(),
        );
        assert!(cookie_token(&headers).is_none());
    }

    #[test]
    fn password_has_eight_uniform_alphabet_characters() {
        let password = random_password().unwrap();
        assert_eq!(password.len(), 8);
        assert!(password.bytes().all(|b| PASSWORD_ALPHABET.contains(&b)));
        assert!(constant_equal(b"test", b"test"));
        assert!(!constant_equal(b"test", b"tEst"));
    }

    fn test_directory() -> PathBuf {
        std::env::temp_dir().join(format!("studyvis-browser-test-{}", random_hex(16).unwrap()))
    }

    fn options(directory: &Path, lease: Duration) -> MirrorServerOptions {
        MirrorServerOptions {
            certificate_dir: directory.to_path_buf(),
            addresses: vec![Ipv4Addr::LOCALHOST],
            asset: Arc::new(|path| {
                (path == "mirror.html").then(|| MirrorAsset {
                    bytes: b"<html>Browser</html>".to_vec(),
                    mime_type: "text/html".into(),
                })
            }),
            on_event: Arc::new(|_| {}),
            lease,
        }
    }

    #[tokio::test]
    async fn tls_pairing_revocation_and_stable_origin() {
        let directory = test_directory();
        let server = MirrorServer::start(options(&directory, Duration::from_secs(60)))
            .await
            .unwrap();
        let config = server.config().clone();
        let root =
            reqwest::Certificate::from_der(&fs::read(directory.join("root.crt")).unwrap()).unwrap();
        let client = reqwest::Client::builder()
            .add_root_certificate(root)
            .no_proxy()
            .build()
            .unwrap();
        let url = &config.urls[0];
        let response = client.get(url).send().await.unwrap();
        assert_eq!(response.status(), 200);
        assert!(response.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains(&url.replace("https://", "wss://")));
        assert_eq!(
            client
                .get(format!("{url}/index.html"))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        assert_eq!(
            client
                .get(format!("{url}/api/status"))
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        let endpoint = format!("{url}/api/pair");
        assert_eq!(
            client
                .post(&endpoint)
                .body("{}")
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        assert_eq!(
            client
                .post(&endpoint)
                .header("Origin", "https://evil.example")
                .header("Content-Type", "application/json")
                .body(serde_json::json!({"password": config.password}).to_string())
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        let paired = client
            .post(&endpoint)
            .header("Origin", url)
            .header("Content-Type", "application/json")
            .body(serde_json::json!({"password": config.password}).to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(paired.status(), 200);
        let cookie = paired.headers()["set-cookie"].to_str().unwrap().to_string();
        assert!(cookie.contains("Secure; HttpOnly; SameSite=Strict"));
        let cookie = cookie.split(';').next().unwrap();
        assert_eq!(
            client
                .get(format!("{url}/api/status"))
                .header("Cookie", cookie)
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        assert_eq!(
            client
                .post(&endpoint)
                .header("Origin", url)
                .header("Content-Type", "application/json")
                .body(serde_json::json!({"password": config.password}).to_string())
                .send()
                .await
                .unwrap()
                .status(),
            409
        );
        server.shutdown().await;
        let renewed = MirrorServer::start(options(&directory, Duration::from_secs(60)))
            .await
            .unwrap();
        assert_eq!(renewed.config().urls, config.urls);
        assert_eq!(renewed.config().fingerprint, config.fingerprint);
        assert_ne!(renewed.config().generation, config.generation);
        assert_ne!(renewed.config().password, config.password);
        assert_eq!(
            client
                .get(format!("{url}/api/status"))
                .header("Cookie", cookie)
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        renewed.shutdown().await;
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn trusted_tls_enforces_request_size_and_pairing_budgets() {
        let directory = test_directory();
        let server = MirrorServer::start(options(&directory, Duration::from_secs(60)))
            .await
            .unwrap();
        let url = &server.config().urls[0];
        let client = reqwest::Client::builder()
            .add_root_certificate(
                reqwest::Certificate::from_der(&fs::read(directory.join("root.crt")).unwrap())
                    .unwrap(),
            )
            .no_proxy()
            .build()
            .unwrap();
        let endpoint = format!("{url}/api/pair");
        let pair_request = |password: &str| {
            client
                .post(&endpoint)
                .header("Origin", url)
                .header("Content-Type", "application/json")
                .body(serde_json::json!({"password": password}).to_string())
        };
        assert_eq!(
            pair_request(&"x".repeat(2048))
                .send()
                .await
                .unwrap()
                .status(),
            413
        );
        for _ in 0..5 {
            assert_eq!(
                pair_request("incorrect").send().await.unwrap().status(),
                401
            );
        }
        let limited = pair_request(&server.config().password)
            .send()
            .await
            .unwrap();
        assert_eq!(limited.status(), 429);
        assert_eq!(limited.headers()["retry-after"], "60");
        assert_eq!(
            client
                .get(format!("{url}/api/status"))
                .header("Origin", "https://evil.example")
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        server.shutdown().await;
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn reconnect_assigns_a_new_socket_target_and_revokes_the_previous_one() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let directory = test_directory();
        let events = Arc::new(Mutex::new(Vec::new()));
        let collected = events.clone();
        let mut server_options = options(&directory, Duration::from_secs(60));
        server_options.on_event = Arc::new(move |event| collected.lock().unwrap().push(event));
        let server = MirrorServer::start(server_options).await.unwrap();
        let url = &server.config().urls[0];
        let client = reqwest::Client::builder()
            .add_root_certificate(
                reqwest::Certificate::from_der(&fs::read(directory.join("root.crt")).unwrap())
                    .unwrap(),
            )
            .no_proxy()
            .build()
            .unwrap();
        let response = client
            .post(format!("{url}/api/pair"))
            .header("Origin", url)
            .header("Content-Type", "application/json")
            .body(serde_json::json!({"password": server.config().password}).to_string())
            .send()
            .await
            .unwrap();
        let cookie = response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();
        let upgrade = || {
            client
                .get(format!("{url}/api/socket"))
                .header("Origin", url)
                .header("Cookie", &cookie)
                .header("Connection", "upgrade")
                .header("Upgrade", "websocket")
                .header("Sec-WebSocket-Version", "13")
                .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
        };
        let first_response = upgrade().send().await.unwrap();
        assert_eq!(first_response.status(), 101);
        let mut first_socket = first_response.upgrade().await.unwrap();
        let first_id = wait_for_connection(&events, 1).await;
        assert!(server.sender(&first_id).is_ok());
        let second_response = upgrade().send().await.unwrap();
        assert_eq!(second_response.status(), 101);
        let mut second_socket = second_response.upgrade().await.unwrap();
        let second_id = wait_for_connection(&events, 2).await;
        assert_ne!(first_id, second_id);
        assert!(server.sender(&first_id).is_err());
        assert!(server.sender(&second_id).is_ok());
        // A replaced tab must stop retrying, or two tabs can steal capture
        // from each other in a perpetual reconnect loop.
        let close_code = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let mut header = [0; 2];
                first_socket.read_exact(&mut header).await.unwrap();
                assert_eq!(header[1] & 0x80, 0);
                assert!(header[1] < 126);
                let mut payload = vec![0; header[1] as usize];
                first_socket.read_exact(&mut payload).await.unwrap();
                if header[0] & 0x0f == 8 {
                    assert!(payload.len() >= 2);
                    break u16::from_be_bytes([payload[0], payload[1]]);
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(close_code, 4001);
        // An actual client-masked text frame reaches only the replacement ID.
        second_socket
            .write_all(&[0x81, 0x82, 1, 2, 3, 4, b'{' ^ 1, b'}' ^ 2])
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if events.lock().unwrap().iter().any(|event| {
                    matches!(event, MirrorEvent::Message { client_id, data } if client_id == &second_id && data == "{}")
                }) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        {
            let collected = events.lock().unwrap();
            let ordered: Vec<_> = collected
                .iter()
                .filter_map(|event| match event {
                    MirrorEvent::Client {
                        client_id,
                        connected,
                    } => Some((client_id.as_str(), *connected)),
                    _ => None,
                })
                .collect();
            assert_eq!(
                ordered[..3],
                [(&*first_id, true), (&*first_id, false), (&*second_id, true)]
            );
        }
        server.shutdown().await;
        fs::remove_dir_all(directory).unwrap();
    }

    async fn wait_for_connection(events: &Mutex<Vec<MirrorEvent>>, count: usize) -> String {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let connected: Vec<_> = events
                    .lock()
                    .unwrap()
                    .iter()
                    .filter_map(|event| match event {
                        MirrorEvent::Client {
                            client_id,
                            connected: true,
                        } => Some(client_id.clone()),
                        _ => None,
                    })
                    .collect();
                if connected.len() >= count {
                    return connected[count - 1].clone();
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn lease_expires_and_certificate_material_remains_private() {
        let directory = test_directory();
        let server = MirrorServer::start(options(&directory, Duration::from_millis(50)))
            .await
            .unwrap();
        let first = load_certificates(&directory, &[Ipv4Addr::LOCALHOST]).unwrap();
        let second = load_certificates(&directory, &[Ipv4Addr::LOCALHOST]).unwrap();
        assert_eq!(first.root, second.root);
        assert_eq!(first.leaf, second.leaf);
        assert_eq!(first.key, second.key);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(directory.join("root-key.pem"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(directory.join("server.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!server.shared.active());
        assert!(server.send("absent", "{}".into()).await.is_err());
        server.shutdown().await;
        for url in [&server.config().urls[0], &server.config().certificate_url] {
            let url = reqwest::Url::parse(url).unwrap();
            assert!(
                tokio::net::TcpStream::connect((url.host_str().unwrap(), url.port().unwrap()))
                    .await
                    .is_err()
            );
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn legacy_leaf_is_renewed_without_rotating_the_trusted_root() {
        use x509_parser::{extensions::ParsedExtension, parse_x509_certificate};

        let directory = test_directory();
        load_certificates(&directory, &[Ipv4Addr::LOCALHOST]).unwrap();
        let mut params = CertificateParams::new(Vec::new()).unwrap();
        params
            .distinguished_name
            .push(DnType::CommonName, "StudyVis local browser access");
        params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        let root_key = KeyPair::generate().unwrap();
        let root = params.self_signed(&root_key).unwrap().der().to_vec();
        write_private_replace(&directory.join("root.crt"), &root).unwrap();
        write_private_replace(
            &directory.join("root-key.pem"),
            root_key.serialize_pem().as_bytes(),
        )
        .unwrap();
        let issuer = Issuer::new(params, root_key);
        let mut params = CertificateParams::new(vec![Ipv4Addr::LOCALHOST.to_string()]).unwrap();
        params
            .distinguished_name
            .push(DnType::CommonName, "StudyVis local browser access");
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        let leaf_key = KeyPair::generate().unwrap();
        let legacy = StoredLeaf {
            addresses: vec![Ipv4Addr::LOCALHOST],
            certificate: params.signed_by(&leaf_key, &issuer).unwrap().der().to_vec(),
            key: leaf_key.serialize_der(),
            renew_after: (time::OffsetDateTime::now_utc() + time::Duration::days(335))
                .unix_timestamp(),
        };
        write_private_replace(
            &directory.join("server.json"),
            &serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();
        let renewed = load_certificates(&directory, &[Ipv4Addr::LOCALHOST]).unwrap();
        assert_eq!(renewed.root, root);
        assert_ne!(renewed.leaf, legacy.certificate);
        assert_ne!(renewed.key, legacy.key);
        let (_, root) = parse_x509_certificate(&renewed.root).unwrap();
        let (_, leaf) = parse_x509_certificate(&renewed.leaf).unwrap();
        assert_ne!(leaf.subject(), leaf.issuer());
        assert_eq!(leaf.issuer(), root.subject());
        let root_id = root.extensions().iter().find_map(|extension| {
            if let ParsedExtension::SubjectKeyIdentifier(id) = extension.parsed_extension() {
                Some(id.0)
            } else {
                None
            }
        });
        let issuer_id = leaf.extensions().iter().find_map(|extension| {
            if let ParsedExtension::AuthorityKeyIdentifier(id) = extension.parsed_extension() {
                id.key_identifier.as_ref().map(|id| id.0)
            } else {
                None
            }
        });
        assert!(root_id.is_some());
        assert_eq!(issuer_id, root_id);
        let reused = load_certificates(&directory, &[Ipv4Addr::LOCALHOST]).unwrap();
        assert_eq!(reused.root, renewed.root);
        assert_eq!(reused.leaf, renewed.leaf);
        assert_eq!(reused.key, renewed.key);
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_certificate_storage_has_a_protected_owner_only_acl() {
        use std::os::windows::ffi::OsStrExt;
        use std::ptr;
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW, GetNamedSecurityInfoW,
            SE_FILE_OBJECT,
        };
        use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;

        let directory = test_directory();
        load_certificates(&directory, &[Ipv4Addr::LOCALHOST]).unwrap();
        for path in [
            directory.clone(),
            directory.join("root-key.pem"),
            directory.join("server.json"),
        ] {
            let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let mut descriptor = ptr::null_mut();
            let mut text = ptr::null_mut();
            let mut length = 0;
            unsafe {
                assert_eq!(
                    GetNamedSecurityInfoW(
                        name.as_ptr(),
                        SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION,
                        ptr::null_mut(),
                        ptr::null_mut(),
                        ptr::null_mut(),
                        ptr::null_mut(),
                        &mut descriptor,
                    ),
                    0
                );
                let converted = ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor,
                    1,
                    DACL_SECURITY_INFORMATION,
                    &mut text,
                    &mut length,
                );
                LocalFree(descriptor);
                assert_ne!(converted, 0);
                let sddl =
                    String::from_utf16(std::slice::from_raw_parts(text, length as usize - 1))
                        .unwrap();
                LocalFree(text.cast());
                assert!(sddl.starts_with("D:P"), "{sddl}");
                assert_eq!(sddl.matches("(A;").count(), 3, "{sddl}");
                for principal in ["OW", "SY", "BA"] {
                    assert!(sddl.contains(&format!(";;;{principal})")), "{sddl}");
                }
                assert!(!sddl.contains(";;;WD)"), "{sddl}");
                assert!(!sddl.contains(";;;BU)"), "{sddl}");
            }
        }
        fs::remove_dir_all(directory).unwrap();
    }
}
