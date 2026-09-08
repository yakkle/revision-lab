import {
  CONTROL, RESPONSE_BYTES, RPC_TIMEOUT_MS, STATE, isPgResult, rpcError,
  type Envelope, type PgRequest, type PgResult, type TaggedValue,
} from "./protocol";

type PgPayload =
  | { op: "QUERY"; sql: string; params: TaggedValue[] }
  | { op: "EXECUTE_MANY"; sql: string; paramSets: TaggedValue[][] };

export function publishResponse(control: Int32Array, response: Uint8Array, sequence: number, value: PgResult): void {
  if (Atomics.load(control, CONTROL.STATE) !== STATE.WAITING) return;
  let bytes: Uint8Array;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(value));
  } catch {
    value = rpcError("RPC_ENCODING_ERROR");
    bytes = new TextEncoder().encode(JSON.stringify(value));
  }
  if (bytes.length > response.length) {
    value = rpcError("RPC_RESPONSE_TOO_LARGE", `RPC response exceeds ${RESPONSE_BYTES} bytes`);
    bytes = new TextEncoder().encode(JSON.stringify(value));
  }
  response.set(bytes);
  Atomics.store(control, CONTROL.LENGTH, bytes.length);
  Atomics.store(control, CONTROL.RESPONSE_SEQUENCE, sequence);
  Atomics.store(control, CONTROL.STATE, value.ok ? STATE.OK : STATE.ERROR);
  Atomics.notify(control, CONTROL.STATE);
}

export class SyncRpc {
  private sequence = 0;
  private broken = false;

  constructor(
    private readonly port: MessagePort,
    private readonly control: Int32Array,
    private readonly response: Uint8Array,
    private readonly context: Envelope,
    private readonly timeoutMs = RPC_TIMEOUT_MS,
  ) {}

  query(sql: string, params: TaggedValue[]): PgResult {
    return this.request({ op: "QUERY", sql, params });
  }

  executeMany(sql: string, paramSets: TaggedValue[][]): PgResult {
    return this.request({ op: "EXECUTE_MANY", sql, paramSets });
  }

  private request(payload: PgPayload): PgResult {
    if (this.broken) return rpcError("RPC_CONNECTION_BROKEN");
    if (Atomics.load(this.control, CONTROL.STATE) !== STATE.IDLE) return rpcError("RPC_BUSY");

    const sequence = ++this.sequence;
    const request = {
      ...this.context,
      requestId: `${this.context.requestId}:${sequence}`,
      sequence,
      ...payload,
    } as PgRequest;
    Atomics.store(this.control, CONTROL.REQUEST_SEQUENCE, sequence);
    Atomics.store(this.control, CONTROL.STATE, STATE.WAITING);
    this.port.postMessage(request);

    const deadline = performance.now() + this.timeoutMs;
    while (Atomics.load(this.control, CONTROL.STATE) === STATE.WAITING) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return this.fail("RPC_TIMEOUT");
      Atomics.wait(this.control, CONTROL.STATE, STATE.WAITING, remaining);
    }

    const state = Atomics.load(this.control, CONTROL.STATE);
    const length = Atomics.load(this.control, CONTROL.LENGTH);
    const responseSequence = Atomics.load(this.control, CONTROL.RESPONSE_SEQUENCE);
    if (state === STATE.BROKEN) return this.fail("RPC_WORKER_TERMINATED");
    if ((state !== STATE.OK && state !== STATE.ERROR) || responseSequence !== sequence || length < 1 || length > this.response.length) {
      return this.fail("RPC_PROTOCOL_ERROR", `Invalid header: state=${state}, request=${sequence}, response=${responseSequence}, length=${length}`);
    }

    try {
      const bytes = Uint8Array.from(this.response.subarray(0, length));
      const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!isPgResult(decoded) || decoded.ok !== (state === STATE.OK)) {
        return this.fail("RPC_PROTOCOL_ERROR", `Invalid response body for state ${state}: ${JSON.stringify(decoded).slice(0, 500)}`);
      }
      Atomics.store(this.control, CONTROL.STATE, STATE.IDLE);
      return decoded;
    } catch {
      return this.fail("RPC_PROTOCOL_ERROR", "Response is not valid UTF-8 JSON");
    }
  }

  private fail(code: string, message = code): PgResult {
    this.broken = true;
    Atomics.store(this.control, CONTROL.STATE, STATE.BROKEN);
    return rpcError(code, message);
  }
}
