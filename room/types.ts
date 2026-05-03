import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ParticipantStatus } from "./ui.ts";

export type RoomSessionManager = {
	getEntries(): Array<Record<string, unknown>>;
	getSessionFile?(): string | undefined;
	appendCustomEntry?(customType: string, data?: unknown): string;
	appendSessionInfo?(name: string): string;
};

export type RoomCommandContext = {
	cwd: string;
	hasUI: boolean;
	sessionManager: RoomSessionManager;
	signal?: AbortSignal;
	abort?: () => void;
	waitForIdle?(): Promise<void>;
	newSession?(options?: {
		parentSession?: string;
		setup?: (sessionManager: RoomSessionManager) => Promise<void> | void;
		withSession?: (ctx: RoomCommandContext) => Promise<void> | void;
	}): Promise<{ cancelled?: boolean }>;
	switchSession?(
		sessionPath: string,
		options?: {
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
};
