// Stands in for the llama-server sidecar.
//
// The AI pipeline is a long chain — capture, composite, prompt, request, parse,
// score machine, thresholds, alerts, audit rows, report. Only the middle link
// needs a model, and a real one makes the whole chain non-deterministic (and
// slow, and dependent on a multi-gigabyte download). A scripted verdict queue
// turns "does an alert fire after two distracted samples" into an assertion.
//
// Speaks the two endpoints the app calls: `/health` and the OpenAI-compatible
// `/v1/chat/completions` (see src/features/ai/aiAgent.ts).

import { createServer } from 'node:http'

import { listen } from './nostrRelay'

export type LlamaVerdict = {
  /** Raw assistant content. Left free-form so a scenario can also feed the
   *  parser malformed output on purpose. */
  content: string
}

export type LlamaRequest = {
  ts: number
  body: unknown
}

export type LlamaStubHandle = {
  port: number
  url: string
  /** Verdicts are consumed in order; the last one repeats once exhausted. */
  queue: LlamaVerdict[]
  requests: LlamaRequest[]
  push: (verdict: LlamaVerdict) => void
  close: () => Promise<void>
}

export async function startLlamaStub(
  initial: LlamaVerdict[] = []
): Promise<LlamaStubHandle> {
  const queue: LlamaVerdict[] = [...initial]
  const requests: LlamaRequest[] = []
  let last: LlamaVerdict = { content: '{"focused":true,"confidence":0.9}' }

  const server = createServer((req, res) => {
    // llama-server answers every origin, and the app fetches it from the
    // app-origin document. Without the same headers the browser blocks the
    // request before the stub ever sees a body, which reads as a dead model.
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', '*')
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      let body: unknown
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = null
      }
      requests.push({ ts: Date.now(), body })
      const verdict = queue.shift() ?? last
      last = verdict
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: `lab-${requests.length}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'lab-stub',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: verdict.content },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        })
      )
    })
  })

  const port = await listen(server)
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    queue,
    requests,
    push: (verdict) => queue.push(verdict),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}
