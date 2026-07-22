/* Public surface of the Takeout transfer engine. A deployment (this repo's
 * standalone Worker, or an embedded adapter in a larger app) imports from here
 * and from nowhere deeper. NO deployment-specific imports live under this
 * directory — the engine core stays reusable. */

export {
  PART_SIZE,
  DEFAULT_SETTLE_AGE_SECONDS,
  TOKEN_EXPIRY_SKEW_SECONDS,
  DriveAuthRevokedError,
  DriveFileGoneError,
  transferModeSchema,
  transferParamsSchema,
} from './types';
export type {
  DriveFileMeta,
  TransferMode,
  TransferParams,
  DriveTokenSource,
  TransferTarget,
  TransferSelector,
  TransferHooks,
  TransferContext,
  ContextResolver,
} from './types';

export { TAKEOUT_DRIVE_QUERY, batchKey, acceptTakeout, takeoutSelector } from './batch';

export {
  exchangeRefreshToken,
  CachingTokenSource,
  refreshTokenSource,
} from './oauth';
export type { MintedToken, RefreshCredentials, OAuthDeps, TokenMinter } from './oauth';

export { DriveClient } from './drive';
export type { DriveApi, DriveClientDeps } from './drive';

export {
  makeTransferWorkflow,
  runTransfer,
  computePartRanges,
  partCountFor,
  PART_STEP_CONFIG,
} from './workflow';
export type { PartRange, TransferStep } from './workflow';

export { runDiscovery } from './discovery';
export type {
  WorkflowBindingFor,
  DiscoveryDeps,
  DiscoverySummary,
  DiscoveryModeError,
} from './discovery';
