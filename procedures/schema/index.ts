/**
 * Re-export surface for procedures schemas. Mirrors Archon's
 * `packages/workflows/src/schemas/index.ts`. See ARCHON_VERSION.md for sync sha.
 *
 * All schemas are re-exported from this index. Types are derived from schemas
 * via `z.infer<typeof Schema>` (WorkflowDefinition uses `Omit<...>` because
 * node parsing happens per-node in loader.ts).
 */

// Command name validation
export { isValidCommandName } from './command-validation';

// Retry configuration
export { stepRetryConfigSchema } from './retry';
export type { StepRetryConfig } from './retry';

// Loop node configuration
export { loopNodeConfigSchema } from './loop';
export type { LoopNodeConfig } from './loop';

// Hooks
export {
	workflowHookEventSchema,
	workflowHookMatcherSchema,
	workflowNodeHooksSchema,
	WORKFLOW_HOOK_EVENTS,
} from './hooks';
export type { WorkflowHookEvent, WorkflowHookMatcher, WorkflowNodeHooks } from './hooks';

// DAG node types
export {
	triggerRuleSchema,
	TRIGGER_RULES,
	dagNodeBaseSchema,
	commandNodeSchema,
	promptNodeSchema,
	bashNodeSchema,
	loopNodeSchema,
	approvalNodeSchema,
	approvalOnRejectSchema,
	cancelNodeSchema,
	scriptNodeSchema,
	dagNodeSchema,
	isBashNode,
	isLoopNode,
	isApprovalNode,
	isCancelNode,
	isScriptNode,
	isTriggerRule,
	BASH_NODE_AI_FIELDS,
	SCRIPT_NODE_AI_FIELDS,
	LOOP_NODE_AI_FIELDS,
	effortLevelSchema,
	thinkingConfigSchema,
	sandboxSettingsSchema,
	agentDefinitionSchema,
} from './dag-node';
export type {
	TriggerRule,
	DagNodeBase,
	CommandNode,
	PromptNode,
	BashNode,
	LoopNode,
	ApprovalNode,
	ApprovalOnReject,
	CancelNode,
	ScriptNode,
	DagNode,
	EffortLevel,
	ThinkingConfig,
	SandboxSettings,
	AgentDefinition,
} from './dag-node';

// Workflow definition
export {
	modelReasoningEffortSchema,
	webSearchModeSchema,
	workflowBaseSchema,
	workflowDefinitionSchema,
} from './workflow';
export type {
	ModelReasoningEffort,
	WebSearchMode,
	WorkflowBase,
	WorkflowDefinition,
	LoadCommandResult,
	WorkflowExecutionResult,
	WorkflowLoadError,
	WorkflowLoadResult,
	WorkflowSource,
	WorkflowWithSource,
} from './workflow';

// Workflow run state
export {
	workflowRunStatusSchema,
	workflowStepStatusSchema,
	nodeStateSchema,
	nodeOutputSchema,
	workflowRunSchema,
	artifactTypeSchema,
	TERMINAL_WORKFLOW_STATUSES,
	RESUMABLE_WORKFLOW_STATUSES,
	isApprovalContext,
} from './workflow-run';
export type {
	WorkflowRunStatus,
	WorkflowStepStatus,
	NodeState,
	NodeOutput,
	WorkflowRun,
	ArtifactType,
	ApprovalContext,
} from './workflow-run';
