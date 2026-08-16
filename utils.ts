export const HISTORY_LIMIT = 5;

export interface ModelReference {
	provider: string;
	id: string;
}

export interface StoredHistory {
	version: 1;
	models: ModelReference[];
}

export function modelKey(model: ModelReference): string {
	return `${model.provider}\u0000${model.id}`;
}

function isModelReference(value: unknown): value is ModelReference {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { provider?: unknown; id?: unknown };
	return typeof candidate.provider === "string" && candidate.provider.length > 0 &&
		typeof candidate.id === "string" && candidate.id.length > 0;
}

function normalizeHistory(values: unknown[]): ModelReference[] {
	const models: ModelReference[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (!isModelReference(value)) continue;
		const key = modelKey(value);
		if (seen.has(key)) continue;
		seen.add(key);
		models.push({ provider: value.provider, id: value.id });
		if (models.length === HISTORY_LIMIT) break;
	}
	return models;
}

export function decodeHistory(value: unknown): ModelReference[] {
	// Version 0 used a bare array before the package was published.
	if (Array.isArray(value)) return normalizeHistory(value);
	if (!value || typeof value !== "object") return [];
	const candidate = value as { version?: unknown; models?: unknown };
	if (candidate.version !== 1 || !Array.isArray(candidate.models)) return [];
	return normalizeHistory(candidate.models);
}

export function promoteModel(history: readonly ModelReference[], model: ModelReference): ModelReference[] {
	return [
		{ provider: model.provider, id: model.id },
		...history.filter((entry) => modelKey(entry) !== modelKey(model)),
	].slice(0, HISTORY_LIMIT);
}

export function encodeHistory(history: readonly ModelReference[]): StoredHistory {
	return { version: 1, models: normalizeHistory([...history]) };
}

export function getRecentModels<T extends ModelReference>(
	normalModels: readonly T[],
	history: readonly ModelReference[],
	currentModel?: ModelReference,
): T[] {
	const effectiveHistory = currentModel ? promoteModel(history, currentModel) : history;
	const byKey = new Map(normalModels.map((model) => [modelKey(model), model]));
	const recent: T[] = [];
	const seen = new Set<string>();
	for (const reference of effectiveHistory) {
		const key = modelKey(reference);
		if (seen.has(key)) continue;
		seen.add(key);
		const model = byKey.get(key);
		if (model) recent.push(model);
	}
	return recent;
}

export function orderWithRecentDuplicates<T extends ModelReference>(
	normalModels: readonly T[],
	history: readonly ModelReference[],
	currentModel?: ModelReference,
): T[] {
	return [...getRecentModels(normalModels, history, currentModel), ...normalModels];
}
