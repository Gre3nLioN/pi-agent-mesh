/**
 * Aggregator for the orchestrator module's public context types.
 *
 * The facade (`src/orchestrator.ts`) imports these types to cast
 * `this` when calling the module functions. The cast is safe because
 * the `Orchestrator` class has all the fields each context requires;
 * TypeScript's structural typing won't match the private fields
 * (`lastAutoNudgeAt`, `budgetHitsByAgent`) on the class against the
 * same fields declared public on the contexts, so the cast is the
 * documented bridge.
 */

export type { LifecycleCtx } from "./lifecycle.js";
export type { TopicBusCtx } from "./topic-bus.js";
export type { AdminCtx } from "./admin.js";
