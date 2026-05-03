// Narrow color abstraction for widgets so render code stays theme-free
// and tests can stay raw-string assertions. The component layer maps
// these keys to theme.fg / theme.bg / theme.bold via a Colorize adapter.

export type ThemeColorKey =
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "accent"
	| "muted"
	| "dim"
	| "success"
	| "warn"
	| "error"
	| "selectedBg"
	| "bold";

export type Colorize = (key: ThemeColorKey, text: string) => string;

export const noColorize: Colorize = (_key, text) => text;
