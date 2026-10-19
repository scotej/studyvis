import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

const fixture = `import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { SessionView } from '@/features/session/SessionView'
import { AiDialogWindow } from '@/features/ai/AiDialogWindow'
import { buildLeaveHandler } from '@/features/session/lifecycle'
import { useSessionStore } from '@/stores/sessionStore'
import { useIdentityStore } from '@/stores/identityStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useModelStore } from '@/features/ai/modelStore'
import { __setEngineRuntime, readEngineInfo } from '@/features/ai/engine'
import { useFocusStore } from '@/features/ai/focusStore'
import { __setSampleLoopRuntime, getSampleLoopRuntime } from '@/features/ai/sampleLoop'
import { __setCaptureRuntime } from '@/features/ai/captureShared'
import { __setAiAgentRuntime } from '@/features/ai/aiAgent'
import { useSidecarStore } from '@/features/ai/sidecar'
import { __setSessionJournalRuntime } from '@/features/session/sessionJournal'
import { MirrorCodec } from '@/features/mirror/wire'

const mode=new URLSearchParams(location.search).get('mode')??'sample'
const label=mode==='dialog'?'ai-dialog':'main'
const traces:any[]=[]
const callbacks=new Map<number,(x:any)=>void>()
const events=new Map<number,{event:string,handler:number,target:any}>()
let next=1
let root:ReturnType<typeof createRoot>
const bc=new BroadcastChannel('studyvis-ai-lifetime')
function accept(e:any){
  if(e.kind!=='event')return
  if(e.target&&e.target!==label)return
  for(const [id,item] of events){if(item.event===e.event)callbacks.get(item.handler)?.({event:e.event,id,payload:e.payload})}
}
bc.onmessage=e=>accept(e.data)
;(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(_e:string,id:number)=>events.delete(id)}
;(window as any).__TAURI_INTERNALS__={
 metadata:{currentWindow:{label},currentWebview:{label}},
 transformCallback:(fn:(x:any)=>void)=>{const id=next++;callbacks.set(id,fn);return id},
 unregisterCallback:(id:number)=>callbacks.delete(id),
 invoke:async(cmd:string,args:any={})=>{
  if(cmd==='plugin:event|listen'){const id=next++;events.set(id,args);return id}
  if(cmd==='plugin:event|unlisten'){events.delete(args.eventId);return}
  if(cmd==='plugin:event|emit'||cmd==='plugin:event|emit_to'){
   const data={kind:'event',event:args.event,payload:args.payload,target:args.target?.label};traces.push({cmd,...data});bc.postMessage(data);accept(data);return
  }
  if(cmd==='plugin:window|close'){
   traces.push({event:'native-close-requested',at:performance.now()});
   const delay=Number(new URLSearchParams(location.search).get('closeDelay')??0)
   await new Promise(r=>setTimeout(r,delay));root.unmount();traces.push({event:'native-close-completed',at:performance.now()});return
  }
  if(cmd==='sidecar_status')return {running:true,starting:false,port:Number(location.port),model:'/m',mmproj:null,ctx_size:4096,errored:false,last_error:null}
  if(cmd==='sessions_get')return null
  if(cmd==='sessions_insert'||cmd==='sessions_insert_if_absent'){traces.push({event:'persist-session',args});return true}
  if(cmd==='plugin:window|is_focused'||cmd==='plugin:window|is_visible')return true
  if(cmd==='mirror_start')return {urls:['https://127.0.0.1:12345/'],password:'probe-only',fingerprint:'00'.repeat(32),certificateUrl:'https://127.0.0.1:12345/cert',expiresAt:Date.now()+600000,generation:'probe'}
  if(cmd==='plugin:window|available_monitors')return []
  if(cmd==='plugin:store|load')return 1
  if(cmd==='plugin:store|get')return null
  if(cmd.startsWith('plugin:')||cmd.startsWith('session_')||cmd.startsWith('audit_')||cmd==='session_set_active'||cmd==='app_log_append')return null
  return null
 }
}
Object.assign(window,{traces,getEvents:()=>[...events.values()].map(x=>x.event),nativeBlur:()=>accept({kind:'event',event:'tauri://blur'}),snapshot:()=>({sessionTopic:useSessionStore.getState().sessionTopic,topic:useSessionStore.getState().declaredStudyTopic,status:useSessionStore.getState().status,totalSamples:useFocusStore.getState().totalSamples,streak:useFocusStore.getState().machine.consecutiveOffTask})})
const companionCodec=new MirrorCodec()
Object.assign(window,{connectMirror:()=>accept({kind:'event',event:'mirror:client',payload:{clientId:'probe-companion',connected:true}}),companionControl:(control:any)=>companionCodec.send({type:'control',control,requestId:'probe-request'},async data=>accept({kind:'event',event:'mirror:message',payload:{clientId:'probe-companion',data}}))})
__setEngineRuntime({info:async()=>({supported:true,installed:true,source:'bundled',version:'b9095',installing:false,last_error:null,devices:[],device_error:null,hardware_identity:{selection:'auto',topology:[]}}),install:async()=>{},subscribeProgress:async()=>()=>{}})
await readEngineInfo()
useSettingsStore.setState(s=>({status:'ready',values:{...s.values,aiFeaturesEnabled:true,sessionTimelineEnabled:true,captureDisplays:'primary'}}))
useModelStore.setState({status:'ready',activeModelId:'qwen2_5-vl-3b',records:{'qwen2_5-vl-3b':{modelId:'qwen2_5-vl-3b',installedAt:1,benchmark:null}}})
useIdentityStore.setState({status:'ready',identity:null})
__setSessionJournalRuntime({append:async(sid,lines)=>{traces.push({event:'journal',sid,lines})},read:async()=>[],now:Date.now})
__setCaptureRuntime({extractFrame:async()=>({bitmap:{} as ImageBitmap,sourceWidth:640,sourceHeight:360}),encodeJpegBase64:async()=> 'AA==',encodeCompositeJpegBase64:async()=> 'AA==',disposeFrame:()=>{}})
function camera(){const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const ctx=canvas.getContext('2d')!;ctx.fillRect(0,0,64,64);return canvas.captureStream(10)}
const originalMedia=navigator.mediaDevices
Object.defineProperty(originalMedia,'getUserMedia',{value:async()=>camera(),configurable:true})
const sampleRuntime=getSampleLoopRuntime()
__setSampleLoopRuntime({...sampleRuntime,now:Date.now,captureFace:async()=> 'AA==',acquireScreenStream:async()=>camera(),enumerateDisplayCount:async()=>1,modelPaths:async()=>({modelPath:'/m',mmprojPath:'/p'}),readBattery:async()=>({onBattery:false,percent:100}),startSidecar:async()=>{traces.push({event:'sample-start'});useSidecarStore.setState({status:'running',port:Number(location.port),healthy:true});return Number(location.port)},stopSidecar:async()=>{traces.push({event:'sample-stop'})},refreshSidecarStatus:async()=>{}})
__setAiAgentRuntime({now:Date.now,fetch:(...args)=>fetch(...args),getSidecarStatus:async()=>({running:true,starting:false,port:Number(location.port),model:'/m',mmproj:null,ctx_size:4096,errored:false,last_error:null})})
function room(){return {selfId:'audit-self',getPeers:()=>({}),addStream:()=>{},removeStream:()=>{},onPeerJoin:()=>()=>{},onPeerLeave:()=>()=>{},onPeerStream:()=>()=>{},leave:async()=>{},makeAction:()=>({send:async()=>{},receive:()=>{}})} as any}
function beginSession(id:string){
 const r=room(),startedAt=Date.now(),topic=id.repeat(64).slice(0,64)
 const leave=buildLeaveHandler({room:r,topic,startedAt,startedAtMono:performance.now()})
 useSessionStore.getState().setPendingInitialTopic(\`session \${id}\`)
 useSessionStore.getState().begin({room:r,leave,sessionTopic:topic,sessionPassword:'audit',isHost:true,startedAt,startedAtMono:performance.now()})
 traces.push({event:'begin',id})
}
Object.assign(window,{beginSession,endSession:()=>useSessionStore.getState().leave?.()})
function Main(){const active=useSessionStore(s=>s.status==='active');return <MemoryRouter>{active?<SessionView/>:<button onClick={()=>beginSession('b')}>Start B</button>}</MemoryRouter>}
root=createRoot(document.getElementById('root')??document.body.appendChild(document.createElement('div')))
if(mode==='dialog'){
 const w=getCurrentWindow()
 root.render(<AiDialogWindow runtime={{listen:(e,h)=>w.listen(e,x=>h(x.payload as any)),emit:(e,p)=>emit(e,p),close:()=>w.close(),now:Date.now}}/>)
}else {beginSession('a');root.render(<Main/>)}
`

test(
  'all session topic sources refresh the open AI dialog (#406)',
  { timeout: 120_000 },
  async () => {
    const requests = []
    const entry = process.cwd() + '/__dialog_topic_fixture.tsx'
    const server = await createServer({
      cacheDir: '/tmp/studyvis-406-fixture-vite',
      server: { host: '127.0.0.1', port: 0 },
      plugins: [
        {
          name: 'dialog-topic-fixture',
          enforce: 'pre',
          resolveId: (id) =>
            id === '/__dialog_topic_fixture.tsx' || id === entry ? entry : null,
          load: (id) => (id === entry ? fixture : null),
          configureServer(vite) {
            vite.middlewares.use((req, res, next) => {
              if (req.url === '/health') {
                res.setHeader('Content-Type', 'application/json')
                res.end('{"status":"ok"}')
                return
              }
              if (req.url === '/v1/chat/completions') {
                let raw = ''
                req.on('data', (chunk) => (raw += chunk))
                req.on('end', () => {
                  const body = JSON.parse(raw)
                  const prompt = body.messages?.[1]?.content
                  let reply
                  if (typeof prompt !== 'string')
                    reply = {
                      severity: 'on_task',
                      reasoning: 'Synthetic test task',
                      on_topic_confidence: 1,
                    }
                  else {
                    requests.push(body)
                    const topic = prompt
                      .split('<declared_topic>')[1]
                      ?.split('</declared_topic>')[0]
                      ?.trim()
                    reply = prompt.endsWith('Switch to physics')
                      ? {
                          intent: 'topic_change',
                          payload: { new_topic: 'physics from dialog' },
                          reply_text: 'Changed to physics from dialog.',
                        }
                      : {
                          intent: 'question',
                          payload: {},
                          reply_text: 'Your topic is ' + topic + '.',
                        }
                  }
                  res.setHeader('Content-Type', 'application/json')
                  res.end(
                    JSON.stringify({
                      choices: [
                        { message: { content: JSON.stringify(reply) } },
                      ],
                    })
                  )
                })
                return
              }
              if (
                new URL(req.url, 'http://localhost').pathname !==
                '/fixture.html'
              ) {
                next()
                return
              }
              res.setHeader('Content-Type', 'text/html')
              void vite
                .transformIndexHtml(
                  '/fixture.html',
                  '<!doctype html><html><body><div id="root"></div><script type="module" src="/__dialog_topic_fixture.tsx"></script></body></html>'
                )
                .then((html) => res.end(html))
                .catch(next)
            })
          },
        },
      ],
    })
    let browser
    try {
      await server.listen()
      const origin = server.resolvedUrls.local[0].replace(/\/$/, '')
      browser = await chromium.launch({
        headless: true,
        ...(process.env.LAB_CHROME_EXECUTABLE
          ? { executablePath: process.env.LAB_CHROME_EXECUTABLE }
          : {}),
      })
      const context = await browser.newContext()
      const errors = []
      await context.route('**/*', (route) =>
        route
          .request()
          .url()
          .startsWith(origin + '/')
          ? route.continue()
          : route.abort()
      )
      const open = async (mode) => {
        const page = await context.newPage()
        page.setDefaultTimeout(30_000)
        page.on('pageerror', (error) => errors.push(error.message))
        await page.goto(origin + '/fixture.html?mode=' + mode)
        await page.waitForFunction(() => window.snapshot !== undefined)
        return page
      }
      const main = await open('main')
      await main
        .getByRole('button', { name: 'Use a browser', exact: true })
        .click()
      await main
        .getByRole('button', { name: 'Start browser companion', exact: true })
        .click()
      await main.waitForFunction(() =>
        window.getEvents().includes('mirror:client')
      )
      await main.evaluate(() => window.connectMirror())
      const dialog = await open('dialog')
      const ask = async (topic) => {
        await dialog.getByRole('textbox').fill('What topic did I declare?')
        await dialog.getByRole('textbox').press('Enter')
        await dialog
          .getByText('Your topic is ' + topic + '.', { exact: true })
          .waitFor()
        const promptTopic = requests
          .at(-1)
          .messages[1].content.match(
            /<declared_topic>([\s\S]*?)<\/declared_topic>/
          )?.[1]
          .trim()
        assert.equal(promptTopic, topic)
      }
      await ask('session a')
      for (const topic of [
        'calculus from companion',
        'chemistry from companion',
      ]) {
        await main.evaluate(
          (topic) => window.companionControl({ type: 'topic', topic }),
          topic
        )
        await main.waitForFunction(
          (topic) => window.snapshot().topic === topic,
          topic
        )
        await ask(topic)
      }
      await dialog.getByRole('textbox').fill('Switch to physics')
      await dialog.getByRole('textbox').press('Enter')
      await main.waitForFunction(
        () => window.snapshot().topic === 'physics from dialog'
      )
      await dialog
        .getByText('Changed to physics from dialog.', { exact: true })
        .waitFor()
      await ask('physics from dialog')
      await main.evaluate(() => window.endSession())
      await main.waitForFunction(() => window.snapshot().status === 'ended')
      const afterEnd = await main.evaluate(
        () =>
          window.traces.filter((x) => x.event === 'ai-dialog:context').length
      )
      await main.evaluate(async () => {
        const { useSessionStore } = await import('/src/stores/sessionStore.ts')
        useSessionStore.getState().setDeclaredStudyTopic('after teardown')
      })
      await main.waitForTimeout(50)
      assert.equal(
        await main.evaluate(
          () =>
            window.traces.filter((x) => x.event === 'ai-dialog:context').length
        ),
        afterEnd
      )
      assert.deepEqual(errors, [])
    } finally {
      await browser?.close()
      await server.close()
    }
  }
)
