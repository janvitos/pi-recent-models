import type { ThinkingLevel } from "./state.ts";
import type { ModelReference } from "./utils.ts";

export type SessionSwitchReason = "new" | "resume";
export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";
export type SessionShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

export interface NewSessionModelSelection extends ModelReference {
	thinkingLevel: ThinkingLevel;
}

/** Carries one model selection across Pi's replacement of an extension runtime. */
export class NewSessionModelHandoff {
	private pending: NewSessionModelSelection | undefined;

	beforeSwitch(reason: SessionSwitchReason, model: ModelReference | undefined, thinkingLevel: ThinkingLevel): void {
		this.pending = reason === "new" && model
			? { provider: model.provider, id: model.id, thinkingLevel }
			: undefined;
	}

	beforeShutdown(reason: SessionShutdownReason): void {
		if (reason !== "new") this.pending = undefined;
	}

	consume(reason: SessionStartReason, enabled: boolean): NewSessionModelSelection | undefined {
		const model = enabled && reason === "new" ? this.pending : undefined;
		this.pending = undefined;
		return model;
	}

	clear(): void {
		this.pending = undefined;
	}
}
