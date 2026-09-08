// hrpc-inspector-probe — L2 collector core. Barrel for the ring buffer, correlator,
// sampler, batched flush and the ingestion sink. Imported by L1 probe adapters
// and the L4 panel.

export { RingBuffer } from './ring-buffer.ts';

export { Collector } from './correlator.ts';
export type {
  RowKind, CollectorRow, PendingRequest, CollectorOptions,
} from './correlator.ts';

export { Sampler } from './sampler.ts';
export type { SamplerOptions, TraceSummary } from './sampler.ts';

export { BatchFlusher } from './flush.ts';
export type { FlushHandler, TimerLike, BatchFlusherOptions } from './flush.ts';

export { CollectorSink, emitSafe } from './sink.ts';
export type { EventSink, L2Event, L2EventType, CollectorSinkOptions } from './sink.ts';

export { Redactor, PEER_HASH_PREFIX, TEXT_HASH_PREFIX } from './redactor.ts';
export type {
  RedactorOptions, ContentSummary, CiphertextSummary,
} from './redactor.ts';
