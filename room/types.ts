import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ParticipantStatus } from "./ui.ts";

export type RoomSessionManager = {
	getEntries(): Array<Record<string, unknown>>;
	getLeafId?(): string | null;
};

export type RoomCommandContext = {
	cwd: string;
	hasUI: boolean;
	sessionManager: RoomSessionManager;
	signal?: AbortSignal;
	abort?: () => void;
	waitForIdle?(): Promise<void>;
	fork?(
		entryId: string,
		options?: {
			position?: "before" | "at";
			withSession?: (ctx: RoomCommandContext) => Promise<void> | void;
		},
	): Promise<{ cancelled?: boolean }>;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		select?(prompt: string, options: string[]): Promise<string | undefined>;
		input?(prompt: string, defaultValue?: string): Promise<string | undefined>;
		setStatus(key: string, value: string | undefined): void;
		setWidget?: ExtensionAPI extends { on: unknown }
			?
					| ((
							key: string,
							content: string[] | undefined,
							options?: { placement?: "aboveEditor" | "belowEditor" },
					  ) => void)
					| ((
							key: string,
							factory: unknown,
							options?: { placement?: "aboveEditor" | "belowEditor" },
					  ) => void)
			: never;
		setWorkingIndicator?: (options?: {
			frames?: string[];
			intervalMs?: number;
		}) => void;
	};
};

export type ParticipantTracker = {
	slug: string;
	role: "speaker" | "moderator";
	status: ParticipantStatus;
	paletteIndex: number;
	/** Timestamp when this participant entered the current thinking/speaking
	 * window. Cleared when status leaves the active range. Used by the
	 * participant bar to render per-mind elapsed time. */
	startedAt?: number;
	/** Most-recent tool the child Pi started executing on this mind's behalf.
	 * `tool` is the bare tool name; `label` is the formatted display string
	 * (tool name + path/command/pattern snippet) used in the participant
	 * bar. Stays visible after `tool_execution_end` so the operator can read
	 * what it just ran; replaced when the next tool starts; cleared when
	 * the mind leaves the active state. Undefined when the mind is not
	 * actively using tools (pure model output, or not active). */
	currentActivity?: { tool: string; label: string; startedAt: number };
};
