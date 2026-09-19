import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { modelKey, type ModelReference } from "./utils.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ThinkingPreference extends ModelReference {
	thinkingLevel: ThinkingLevel;
}

export interface RecentModelsState {
	version: 2;
	models: ModelReference[];
	thinkingMemory: {
		enabled: boolean;
		legacyImported: boolean;
		preferences: ThinkingPreference[];
	};
}

export type DecodedState =
	| { kind: "current"; state: RecentModelsState; issues: string[] }
	| { kind: "future"; version: number }
	| { kind: "invalid"; issues: string[] };

export type StateLogger = (message: string, error?: unknown) => void;

const FILE_VERSION = 2;
const LOCK_OPTIONS = {
	realpath: false,
	stale: 10_000,
	update: 2_000,
	retries: {
		retries: 60,
		factor: 1.2,
		minTimeout: 25,
		maxTimeout: 250,
	},
} as const;

function emptyState(): RecentModelsState {
	return {
		version: FILE_VERSION,
		models: [],
		thinkingMemory: { enabled: false, legacyImported: false, preferences: [] },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function normalizeModels(values: unknown[], issues?: string[], field = "models"): ModelReference[] {
	const models: ModelReference[] = [];
	const seen = new Set<string>();
	for (const [index, value] of values.entries()) {
		if (!isRecord(value) || typeof value.provider !== "string" || value.provider.trim().length === 0 ||
			typeof value.id !== "string" || value.id.trim().length === 0) {
			issues?.push(`${field}[${index}] must contain non-empty provider and id strings`);
			continue;
		}
		const model = { provider: value.provider, id: value.id };
		const key = modelKey(model);
		if (seen.has(key)) {
			issues?.push(`${field}[${index}] duplicates ${model.provider}/${model.id}`);
			continue;
		}
		seen.add(key);
		models.push(model);
	}
	return models;
}

function normalizePreferences(values: unknown[], issues?: string[], field = "thinkingMemory.preferences"): ThinkingPreference[] {
	const preferences = new Map<string, ThinkingPreference>();
	for (const [index, value] of values.entries()) {
		if (!isRecord(value) || typeof value.provider !== "string" || value.provider.trim().length === 0 ||
			typeof value.id !== "string" || value.id.trim().length === 0 || !isThinkingLevel(value.thinkingLevel)) {
			issues?.push(`${field}[${index}] is invalid`);
			continue;
		}
		const preference = { provider: value.provider, id: value.id, thinkingLevel: value.thinkingLevel };
		const key = modelKey(preference);
		if (preferences.has(key)) issues?.push(`${field}[${index}] duplicates ${preference.provider}/${preference.id}; the last value wins`);
		preferences.set(key, preference);
	}
	return [...preferences.values()];
}

export function decodeState(value: unknown): DecodedState {
	if (Array.isArray(value)) {
		const state = emptyState();
		state.models = normalizeModels(value);
		return { kind: "current", state, issues: [] };
	}
	if (!isRecord(value)) return { kind: "invalid", issues: ["root must be an object or legacy array"] };

	const version = value.version;
	if (typeof version === "number" && Number.isInteger(version) && version > FILE_VERSION) {
		return { kind: "future", version };
	}
	if (version === 1) {
		if (!Array.isArray(value.models)) return { kind: "invalid", issues: ["models must be an array"] };
		const state = emptyState();
		state.models = normalizeModels(value.models);
		return { kind: "current", state, issues: [] };
	}
	if (version !== FILE_VERSION) return { kind: "invalid", issues: [`version must be 1 or ${FILE_VERSION}`] };

	const issues: string[] = [];
	const state = emptyState();
	if (Array.isArray(value.models)) state.models = normalizeModels(value.models, issues);
	else issues.push("models must be an array");

	if (!isRecord(value.thinkingMemory)) {
		issues.push("thinkingMemory must be an object");
		return { kind: "current", state, issues };
	}
	if (typeof value.thinkingMemory.enabled === "boolean") state.thinkingMemory.enabled = value.thinkingMemory.enabled;
	else issues.push("thinkingMemory.enabled must be a boolean");
	if (typeof value.thinkingMemory.legacyImported === "boolean") state.thinkingMemory.legacyImported = value.thinkingMemory.legacyImported;
	else issues.push("thinkingMemory.legacyImported must be a boolean");
	if (Array.isArray(value.thinkingMemory.preferences)) {
		state.thinkingMemory.preferences = normalizePreferences(value.thinkingMemory.preferences, issues);
	} else {
		issues.push("thinkingMemory.preferences must be an array");
	}
	return { kind: "current", state, issues };
}

export function decodeLegacyThinkingPreferences(value: unknown): ThinkingPreference[] | undefined {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.preferences)) return undefined;
	const converted = value.preferences.map((entry) => {
		if (!isRecord(entry)) return entry;
		return { provider: entry.provider, id: entry.model, thinkingLevel: entry.thinkingLevel };
	});
	return normalizePreferences(converted);
}

export function encodeState(state: RecentModelsState): string {
	const preferences = [...state.thinkingMemory.preferences].sort(
		(left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
	);
	return `${JSON.stringify({
		version: FILE_VERSION,
		models: normalizeModels(state.models),
		thinkingMemory: {
			enabled: state.thinkingMemory.enabled,
			legacyImported: state.thinkingMemory.legacyImported,
			preferences: normalizePreferences(preferences),
		},
	}, null, 2)}\n`;
}

function defaultLogger(message: string, error?: unknown): void {
	const suffix = error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`;
	console.error(`[pi-recent-models] ${message}${suffix}`);
}

export class RecentModelsStore {
	readonly filePath: string;
	readonly legacyThinkingPath: string;
	private readonly logger: StateLogger;
	private queue: Promise<void> = Promise.resolve();

	constructor(filePath: string, legacyThinkingPath: string, logger: StateLogger = defaultLogger) {
		this.filePath = filePath;
		this.legacyThinkingPath = legacyThinkingPath;
		this.logger = logger;
	}

	load(): Promise<RecentModelsState> {
		return this.enqueue(async () => {
			try {
				return await this.withLock(async (assertLockHealthy) => {
					const decoded = await this.readDecoded();
					assertLockHealthy();
					return decoded.kind === "current" ? decoded.state : emptyState();
				});
			} catch (error) {
				this.logger(`Could not read ${this.filePath}`, error);
				return emptyState();
			}
		});
	}

	promote(model: ModelReference): Promise<RecentModelsState | undefined> {
		return this.update((state) => {
			state.models = [
				{ provider: model.provider, id: model.id },
				...state.models.filter((entry) => modelKey(entry) !== modelKey(model)),
			];
		});
	}

	getThinkingLevel(model: ModelReference): Promise<ThinkingLevel | undefined> {
		return this.enqueue(async () => {
			try {
				return await this.withLock(async (assertLockHealthy) => {
					const decoded = await this.readDecoded();
					assertLockHealthy();
					if (decoded.kind !== "current" || !decoded.state.thinkingMemory.enabled) return undefined;
					return decoded.state.thinkingMemory.preferences.find((entry) => modelKey(entry) === modelKey(model))?.thinkingLevel;
				});
			} catch (error) {
				this.logger(`Could not read thinking preferences from ${this.filePath}`, error);
				return undefined;
			}
		});
	}

	setThinkingLevel(model: ModelReference, thinkingLevel: ThinkingLevel): Promise<boolean> {
		return this.update((state) => {
			if (!state.thinkingMemory.enabled) return;
			state.thinkingMemory.preferences = [
				...state.thinkingMemory.preferences.filter((entry) => modelKey(entry) !== modelKey(model)),
				{ provider: model.provider, id: model.id, thinkingLevel },
			];
		}).then((state) => state !== undefined);
	}

	setThinkingMemoryEnabled(enabled: boolean): Promise<RecentModelsState | undefined> {
		return this.update(async (state) => {
			if (enabled && !state.thinkingMemory.legacyImported) {
				const legacy = await this.readLegacyPreferences();
				if (legacy !== undefined) {
					const preferences = new Map(legacy.map((entry) => [modelKey(entry), entry]));
					for (const entry of state.thinkingMemory.preferences) preferences.set(modelKey(entry), entry);
					state.thinkingMemory.preferences = [...preferences.values()];
					state.thinkingMemory.legacyImported = true;
				}
			}
			state.thinkingMemory.enabled = enabled;
		});
	}

	async drain(): Promise<void> {
		await this.queue;
	}

	private update(
		mutate: (state: RecentModelsState) => void | Promise<void>,
	): Promise<RecentModelsState | undefined> {
		return this.enqueue(async () => {
			try {
				return await this.withLock(async (assertLockHealthy) => {
					const decoded = await this.readDecoded();
					assertLockHealthy();
					if (decoded.kind === "future") {
						this.logger(`Refusing to overwrite ${this.filePath}: schema version ${decoded.version} is newer than ${FILE_VERSION}`);
						return undefined;
					}
					const state = decoded.kind === "current" ? decoded.state : emptyState();
					await mutate(state);
					await this.writeAtomic(encodeState(state), assertLockHealthy);
					return state;
				});
			} catch (error) {
				this.logger(`Could not update ${this.filePath}`, error);
				return undefined;
			}
		});
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation, operation);
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}

	private async withLock<T>(operation: (assertLockHealthy: () => void) => Promise<T>): Promise<T> {
		await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
		let compromisedError: Error | undefined;
		const assertLockHealthy = () => {
			if (compromisedError) throw compromisedError;
		};
		const release = await lockfile.lock(this.filePath, {
			...LOCK_OPTIONS,
			onCompromised: (error) => {
				compromisedError = error;
				this.logger(`Lock for ${this.filePath} was compromised`, error);
			},
		});
		try {
			const result = await operation(assertLockHealthy);
			assertLockHealthy();
			return result;
		} finally {
			try {
				await release();
			} catch (error) {
				if (compromisedError) this.logger(`Could not release compromised lock for ${this.filePath}`, error);
				else throw error;
			}
		}
	}

	private async readDecoded(): Promise<DecodedState> {
		let source: string;
		try {
			source = await readFile(this.filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "current", state: emptyState(), issues: [] };
			throw error;
		}
		let value: unknown;
		try {
			value = JSON.parse(source);
		} catch (error) {
			this.logger(`Ignoring malformed JSON in ${this.filePath}`, error);
			return { kind: "invalid", issues: ["file is not valid JSON"] };
		}
		const decoded = decodeState(value);
		if (decoded.kind === "invalid") this.logger(`Ignoring invalid state in ${this.filePath}: ${decoded.issues.join("; ")}`);
		else if (decoded.kind === "current" && decoded.issues.length > 0) this.logger(`Loaded ${this.filePath} with corrections: ${decoded.issues.join("; ")}`);
		return decoded;
	}

	private async readLegacyPreferences(): Promise<ThinkingPreference[] | undefined> {
		let source: string;
		try {
			source = await readFile(this.legacyThinkingPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			this.logger(`Could not read legacy thinking preferences from ${this.legacyThinkingPath}`, error);
			return undefined;
		}
		try {
			const preferences = decodeLegacyThinkingPreferences(JSON.parse(source));
			if (preferences === undefined) this.logger(`Ignoring invalid legacy thinking preferences in ${this.legacyThinkingPath}`);
			return preferences;
		} catch (error) {
			this.logger(`Ignoring malformed JSON in ${this.legacyThinkingPath}`, error);
			return undefined;
		}
	}

	private async writeAtomic(content: string, assertLockHealthy: () => void): Promise<void> {
		const directory = dirname(this.filePath);
		const temporaryPath = join(directory, `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
		try {
			assertLockHealthy();
			await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
			assertLockHealthy();
			await rename(temporaryPath, this.filePath);
		} finally {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
		}
	}
}
