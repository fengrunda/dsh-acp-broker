/**
 * dsh-acp-broker — library surface.
 *
 * The broker keeps one long-lived `dsh --profile acp` stdio connection and
 * routes named tickets to co-resident ACP sessions. Prompts never close a
 * session, so team-rooms live followup can reach a member that is still loaded.
 */
export { AcpConnection } from "./acp.js";
export type { AcpConnectionOptions, AcpPromptResult, AcpSessionSummary } from "./acp.js";
export { Broker } from "./broker.js";
export type { BrokerOptions } from "./broker.js";
export { TicketStore } from "./tickets.js";
export {
  brokerPaths,
  resolveBrokerDir,
  resolveDshArgs,
  resolveDshBin,
  defaultDshHome,
} from "./paths.js";
export type { BrokerPaths } from "./paths.js";
export { startControlServer, stopControlServer, controlRequest } from "./control.js";
export type { ControlHandler } from "./control.js";
export { startDaemon, stopDaemon, tryStatus } from "./daemon.js";
export { serveDaemon } from "./serve.js";
export type { ServeOptions } from "./serve.js";
export type {
  ControlRequest,
  ControlResponse,
  PromptData,
  StatusData,
  TicketMeta,
} from "./types.js";
