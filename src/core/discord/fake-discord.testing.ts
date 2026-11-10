import { TextDecoder } from "node:util"
import { type Transport, type TransportRequest, TransportFailure } from "./transport"

const API_PREFIX = "/api/v9"
const LOGIN_PATH = "/login"

/** What the fake answers: a JSON body, or plain text. */
export type FakeAnswer = {
  status: number
  json?: unknown
  text?: string
  headers?: Record<string, string>
}

/** A request the fake received, with the headers in the order they were sent. */
export type RecordedRequest = {
  method: string
  url: string
  /** The path after `/api/v9` for an API request, else the URL's own path. */
  path: string
  query: URLSearchParams
  headers: [string, string][]
  body?: string
  /** The raw body, when it was sent as bytes. */
  bytes?: Uint8Array
  navigation?: true
  timeoutMs: number
}

type Route = FakeAnswer | FakeAnswer[] | ((request: RecordedRequest) => FakeAnswer | Promise<FakeAnswer>)

/** The value of a request's header, or `undefined`. */
export function headerOf(request: RecordedRequest, name: string): string | undefined {
  return request.headers.find(([key]) => key === name)?.[1]
}

/** An in-process Discord: a `Transport` that routes by method and path and records what it receives. */
export class FakeDiscord {
  /** The build number the login page carries; none leaves it out. */
  buildNumber: number | undefined = 100_000
  /** The login page, instead of the generated one. */
  loginPage: string | undefined
  loginStatus = 200
  readonly requests: RecordedRequest[] = []
  readonly #routes = new Map<string, Route>()
  readonly #sequences = new Map<string, number>()
  #failures: { failure: TransportFailure; times: number }[] = []

  /** Answers `method path` (the path after `/api/v9`): one answer, a sequence whose last answer repeats, or a function. */
  route(method: string, path: string, answer: Route): this {
    this.#routes.set(`${method} ${path}`, answer)
    this.#sequences.delete(`${method} ${path}`)
    return this
  }

  /** Makes the next `times` requests fail below HTTP. */
  failNext(failure: { dispatched: boolean; message?: string }, times = 1): this {
    this.#failures.push({
      failure: new TransportFailure(failure.message ?? "connection failed", failure.dispatched),
      times,
    })
    return this
  }

  /** Requests to the API. */
  get api(): RecordedRequest[] {
    return this.requests.filter((request) => request.url.includes(API_PREFIX))
  }

  /** Requests for the login page. */
  get login(): RecordedRequest[] {
    return this.requests.filter((request) => request.path === LOGIN_PATH)
  }

  readonly transport: Transport = async (request) => {
    const recorded = record(request)
    this.requests.push(recorded)

    const pending = this.#failures[0]
    if (pending) {
      if (--pending.times <= 0) this.#failures.shift()
      throw pending.failure
    }

    const answer = recorded.path === LOGIN_PATH ? this.#loginAnswer() : await this.#answer(recorded)
    return {
      status: answer.status,
      headers: answer.headers ?? {},
      body: answer.text ?? (answer.json === undefined ? "" : JSON.stringify(answer.json)),
    }
  }

  #loginAnswer(): FakeAnswer {
    const page =
      this.loginPage ??
      (this.buildNumber === undefined
        ? "<html><body>login</body></html>"
        : `<html><script>window.GLOBAL_ENV = {"RELEASE_CHANNEL":"stable","BUILD_NUMBER":"${this.buildNumber}"}</script></html>`)
    return { status: this.loginStatus, text: page }
  }

  async #answer(request: RecordedRequest): Promise<FakeAnswer> {
    const key = `${request.method} ${request.path}`
    const route = this.#routes.get(key)
    if (route === undefined) return { status: 404, json: { code: 0, message: "404: Not Found" } }
    if (typeof route === "function") return route(request)
    if (!Array.isArray(route)) return route
    const index = this.#sequences.get(key) ?? 0
    this.#sequences.set(key, index + 1)
    return route[Math.min(index, route.length - 1)]!
  }
}

function record(request: TransportRequest): RecordedRequest {
  const url = new URL(request.url)
  const body =
    request.body === undefined
      ? undefined
      : typeof request.body === "string"
        ? request.body
        : new TextDecoder().decode(request.body)
  return {
    method: request.method,
    url: request.url,
    path: url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname,
    query: url.searchParams,
    headers: request.headers.map(([name, value]) => [name, value]),
    timeoutMs: request.timeoutMs,
    ...(request.navigation ? { navigation: true as const } : {}),
    ...(body === undefined ? {} : { body }),
    ...(request.body instanceof Uint8Array ? { bytes: request.body } : {}),
  }
}
