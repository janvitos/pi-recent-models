import type { ModelReference } from "./utils.ts";

export type SessionSwitchReason = "new" | "resume";
export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";
export type SessionShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

/** Carries one model selection across Pi's replacement of an extension runtime. */
export class NewSessionModelHandoff {
	private pending: ModelReference | undefined;

	beforeSwitch(reason: SessionSwitchReason, model: ModelReference | undefined): void {
		this.pending = reason === "new" && model
			? { provider: model.provider, id: model.id }
			: undefined;
	}

	beforeShutdown(reason: SessionShutdownReason): void {
		if (reason !== "new") this.pending = undefined;
	}

	consume(reason: SessionStartReason, enabled: boolean): ModelReference | undefined {
		const model = enabled && reason === "new" ? this.pending : undefined;
		this.pending = undefined;
		return model;
	}

	clear(): void {
		this.pending = undefined;
	}
}
