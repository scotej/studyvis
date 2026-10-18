import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

const fixture =
  "import React from 'react'\nimport {createRoot} from 'react-dom/client'\nimport {MemoryRouter} from 'react-router'\nimport {Toaster} from 'sonner'\nimport {ThemeProvider} from '@/design/theme'\nimport {SessionView} from '@/features/session/SessionView'\nimport {QuitConfirmListener} from '@/features/system/QuitConfirmListener'\nimport {AppearanceCategory} from '@/features/settings/categories/AppearanceCategory'\nimport {buildLeaveHandler} from '@/features/session/lifecycle'\nimport {useSessionStore} from '@/stores/sessionStore'\nimport {useIdentityStore} from '@/stores/identityStore'\nimport {useSettingsStore, DEFAULT_SETTINGS} from '@/stores/settingsStore'\nimport {useAuditStore,__setAuditPersistFn,verifyIncomingAuditEvent} from '@/stores/auditStore'\nimport {generateIdentity,signMessage} from '@/lib/crypto/identity'\nimport {bytesToHex} from '@/lib/encoding'\nimport {boxEncrypt,boxDecrypt} from '@/lib/crypto/identity'\nimport {rememberActiveSession,retainSessionRecoveryForQuit,clearSessionRecoveryOnLeave,loadSessionRecovery,__setSessionRecoveryDeps,__resetSessionRecoveryDeps,__flushSessionRecovery} from '@/features/session/recovery'\n\nexport async function startHarness(mode:string) {\n const appearance=false\n const calls:any[]=[],persisted:any[]=[],sent:any[]=[];let synthetic:ReturnType<typeof generateIdentity>\n const callbacks=new Map<number,(x:any)=>void>(),events=new Map<number,any>();let next=1\n const dispatch=(event:string,payload:any)=>{for(const [id,item] of events)if(item.event===event)callbacks.get(item.handler)?.({event,id,payload})}\n Object.assign(window,{__TAURI_EVENT_PLUGIN_INTERNALS__:{unregisterListener:(_e:string,id:number)=>events.delete(id)},__TAURI_INTERNALS__:{metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:(fn:any)=>{const id=next++;callbacks.set(id,fn);return id},unregisterCallback:(id:number)=>callbacks.delete(id),invoke:async(cmd:string,args:any={})=>{\n  calls.push({cmd,args})\n  if(cmd==='plugin:event|listen'){const id=next++;events.set(id,args);return id}\n  if(cmd==='plugin:event|unlisten'){events.delete(args.eventId);return}\n  if(cmd==='plugin:event|emit'||cmd==='plugin:event|emit_to'){dispatch(args.event,args.payload);return}\n  if(cmd==='plugin:window|is_focused'||cmd==='plugin:window|is_visible')return true\n  if(cmd==='plugin:window|available_monitors')return []\n  if(cmd==='system_window_style_is_custom_applied')return false\n  if(cmd==='system_relaunch_app')throw new Error('a study session is running')\n  if(cmd==='identity_sign')return Array.from(signMessage(synthetic.edPriv,new Uint8Array(args.message)))\n  if(cmd==='sessions_get')return null\n  if(cmd==='sessions_insert'||cmd==='sessions_insert_if_absent')return true\n  if(cmd==='plugin:store|load')return 1\n  if(cmd==='plugin:store|get')return null\n  return null\n }}})\n await new Promise(resolve=>setTimeout(resolve,0))\n synthetic=generateIdentity();const ed=bytesToHex(synthetic.edPub),x=bytesToHex(synthetic.xPub)\n const actions=useIdentityStore.getState().actions\n useIdentityStore.setState({status:'ready',identity:{version:1,ed_pubkey_hex:ed,x_pubkey_hex:x,display_name:'Synthetic audit participant',created_at:1,mnemonic_fingerprint:'synthetic'},actions:{...actions,signWithKeyring:async bytes=>signMessage(synthetic.edPriv,bytes)}})\n useSettingsStore.setState({status:'ready',values:{...DEFAULT_SETTINGS,autoUpdateEnabled:false,aiFeaturesEnabled:false,windowStyle:appearance?'custom':'system'},error:null})\n useAuditStore.getState().reset();useSessionStore.getState().reset()\n __setAuditPersistFn(async event=>{persisted.push(event)})\n const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;canvas.getContext('2d')!.fillRect(0,0,32,32)\n Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>canvas.captureStream(1),configurable:true})\n const room:any={selfId:'audit-self',getPeers:()=>({}),onPeerJoin:()=>()=>{},onPeerLeave:()=>()=>{},onPeerStream:()=>()=>{},addStream:()=>{},removeStream:()=>{},leave:async()=>{calls.push({cmd:'room.leave'})},makeAction:(name:string)=>({send:async(data:any)=>{sent.push({name,data})},receive:()=>{}})}\n if(mode!=='relaunch') {\n  const startedAt=Date.now()-60000,topic='c'.repeat(64)\n  const leave=buildLeaveHandler({room,topic,startedAt,startedAtMono:performance.now()-60000,localEdPubkey:ed,localDisplayName:'Synthetic audit participant'})\n  useSessionStore.getState().begin({room,leave,sessionTopic:topic,sessionPassword:'synthetic',isHost:mode!=='quit-guest',startedAt,startedAtMono:performance.now()-60000})\n }\n function Main(){const active=useSessionStore(s=>s.status==='active');return <MemoryRouter><ThemeProvider><Toaster/>{appearance?<AppearanceCategory/>:active?<SessionView/>:<div>Ended</div>}<QuitConfirmListener/></ThemeProvider></MemoryRouter>}\n const root=createRoot(document.body.appendChild(document.createElement('div')));root.render(<Main/>);\n return {dispatch,snapshot:()=>({calls,persistedKinds:persisted.map(e=>e.kind),signedKinds:sent.filter(x=>x.data?.kind).map(x=>x.data.kind),verified:sent.filter(x=>x.data?.kind).every(x=>verifyIncomingAuditEvent(x.data,ed)!==null),status:useSessionStore.getState().status,settingsError:useSettingsStore.getState().error}),recoveryControl:async()=>{\n  const result:any[]=[]\n  for(const isHost of [true,false]) {\n   __resetSessionRecoveryDeps();const saved=new Map<string,any>()\n   __setSessionRecoveryDeps({storeFactory:()=>({get:async k=>saved.get(k),set:async(k,v)=>{saved.set(k,v)},delete:async k=>saved.delete(k),save:async()=>{}}),seal:async(pub,data)=>boxEncrypt(pub,synthetic.xPriv,data),open:async(pub,nonce,data)=>boxDecrypt(pub,synthetic.xPriv,nonce,data)})\n   rememberActiveSession({identity:{ed_pubkey_hex:ed,x_pubkey_hex:x},sessionTopic:'d'.repeat(64),sessionPassword:'synthetic',isHost,expectedAuthorityEdPubkeyHex:isHost?null:ed,declaredStudyTopic:'Synthetic study',startedAt:Date.now()-60000});await __flushSessionRecovery()\n   retainSessionRecoveryForQuit();await clearSessionRecoveryOnLeave();await __flushSessionRecovery()\n   result.push({isHost,savedEntries:saved.size,nextLaunch:(await loadSessionRecovery({edPubkeyHex:ed,xPubkeyHex:x})).kind})\n  }\n  __resetSessionRecoveryDeps();return result\n },stop:()=>root.unmount()}\n}\n"

test(
  'Leave and confirmed Quit persist and broadcast one signed departure (#413)',
  { timeout: 120_000 },
  async () => {
    const entry = process.cwd() + '/__signed_quit_fixture.tsx'
    const server = await createServer({
      cacheDir: '/tmp/studyvis-signed-quit-vite',
      server: { host: '127.0.0.1', port: 0 },
      plugins: [
        {
          name: 'signed-quit-fixture',
          enforce: 'pre',
          resolveId: (id) =>
            id === '/__signed_quit_fixture.tsx' || id === entry ? entry : null,
          load: (id) => (id === entry ? fixture : null),
          configureServer(vite) {
            vite.middlewares.use((req, res, next) => {
              if (
                new URL(req.url, 'http://localhost').pathname !==
                '/fixture.html'
              )
                return next()
              res.setHeader('Content-Type', 'text/html')
              void vite
                .transformIndexHtml(
                  '/fixture.html',
                  '<!doctype html><html><body><script type="module">import { startHarness } from "/__signed_quit_fixture.tsx";window.harness=await startHarness(new URLSearchParams(location.search).get("mode"))</script></body></html>'
                )
                .then((html) => res.end(html))
                .catch(next)
            })
          },
        },
      ],
    })
    await server.listen()
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.LAB_CHROME_EXECUTABLE
        ? { executablePath: process.env.LAB_CHROME_EXECUTABLE }
        : {}),
    })
    try {
      for (const mode of ['leave', 'quit', 'quit-guest']) {
        const page = await browser.newPage()
        const errors = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.route('**/*', (route) => {
          const url = new URL(route.request().url())
          return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
            !['http:', 'https:'].includes(url.protocol)
            ? route.continue()
            : route.abort()
        })
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/fixture.html?mode=${mode}`
        )
        await page.waitForFunction(() =>
          window.harness?.snapshot().persistedKinds.includes('joined')
        )
        if (mode === 'leave') {
          await page.getByRole('button', { name: 'Leave', exact: true }).click()
          await page.waitForFunction(
            () => window.harness.snapshot().status === 'ended'
          )
        } else {
          await page.evaluate(() =>
            window.harness.dispatch('quit-requested', null)
          )
          await page
            .getByRole('button', { name: 'Leave and quit', exact: true })
            .click()
          await page.waitForFunction(() =>
            window.harness
              .snapshot()
              .calls.some((call) => call.cmd === 'app_quit')
          )
        }
        const result = await page.evaluate(() => window.harness.snapshot())
        assert.equal(
          result.persistedKinds.filter((kind) => kind === 'left').length,
          1,
          mode
        )
        assert.equal(
          result.signedKinds.filter((kind) => kind === 'left').length,
          1,
          mode
        )
        assert.equal(result.verified, true, mode)
        assert.equal(
          result.calls.filter((call) => call.cmd === 'room.leave').length,
          1,
          mode
        )
        assert.ok(
          result.calls.some((call) => call.cmd === 'sessions_insert'),
          mode
        )
        if (mode !== 'leave') {
          assert.ok(
            result.calls.findIndex((call) => call.cmd === 'sessions_insert') <
              result.calls.findIndex((call) => call.cmd === 'app_quit'),
            mode
          )
        }
        assert.deepEqual(errors, [], mode)
        await page.evaluate(() => window.harness.stop())
        await page.close()
      }
    } finally {
      await browser.close()
      await server.close()
    }
  }
)
