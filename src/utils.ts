import { watch, ref, computed } from 'vue';
import type { Ref } from 'vue';
import { useApi, useStores } from '@directus/extensions-sdk';
import { Relation } from '@directus/shared/types';

export function checkFieldInTemplate(template: string, field: string) {
	const matches = template.match(/{{.*?}}/g);
	return (matches || []).some((m) => m.includes(field));
}

/** Simple check which fields are used */
function shouldUpdate(
	template: string,
	computedField: string,
	val: Record<string, any>,
	oldVal: Record<string, any>,
) {
	const changedFields = [];
	for (const key of Object.keys({ ...oldVal, ...val })) {
		if (
			key !== computedField &&
			val[key] !== oldVal[key] &&
			JSON.stringify(val[key]) !== JSON.stringify(oldVal[key])
		) {
			changedFields.push(key);
		}
	}

	if (!changedFields.length) {
		// update even if no fields changed
		return true;
	}

	return changedFields.some((field) => checkFieldInTemplate(template, field));
}

export const useCollectionRelations = (collection: string): Ref<Relation[]> => {
	const { useRelationsStore } = useStores();
	const { getRelationsForCollection } = useRelationsStore();
	return ref(getRelationsForCollection(collection));
};

interface IRelationUpdate {
	create?: Record<string, any>[];
	update?: Record<string, any>[];
	delete?: (string | number)[];
}

export const useDeepValues = (
	values: Ref<Record<string, any>>,
	relations: Ref<Relation[]>,
	collection: Ref<string>,
	computedField: Ref<string>,
	pk: Ref<string | number>,
	template: string
) => {
	const api = useApi();
	const userStore = useStores().useUserStore();
	const finalValues = ref<Record<string, any>>({
		__currentUser: userStore.currentUser,
	});
	let fieldCache: Record<string, any> = {};
	let itemCache: Record<string, any> = {};
	// Directus store o2m value as reference so when o2m updated, val & oldVal in watch are the same.
	// This will serialize values so when o2m fields are updated, their changes can be seen.
	const cloneValues = computed(() => JSON.stringify(
		values.value,
		(k, v) => v === undefined ? null : v, // convert all undefined values to null to prevent JSON.stringify from removing their keys
	));

	watch(
		cloneValues,
		async (val, oldVal) => {
			const valObj = JSON.parse(val);
			const oldValObj = oldVal !== undefined ? JSON.parse(oldVal) : {};
			if (!shouldUpdate(template, computedField.value, valObj, oldValObj)) {
				return;
			}

			for (const key of Object.keys(oldValObj)) {
				if (!(key in valObj)) {
					valObj[key] = null;
				}
			}

			let relationalData: Record<string, any> = {};
			const pkFinal = valObj.id || pk.value;

			for (const key of Object.keys(valObj)) {
				const relation = relations.value.find((rel) => [rel.meta?.one_field, rel.meta?.many_field].includes(key));

				if (!relation || !checkFieldInTemplate(template, key)) {
					continue;
				}

				const isM2O = relation.collection === collection.value;
				const fieldName = isM2O ? relation.meta?.many_field : relation.meta?.one_field;

				let fieldChanges = valObj[fieldName!] as IRelationUpdate ?? {
					create: [],
					update: [],
					delete: [],
				};

				let arrayOfIds: (string | number)[] = [];
				let arrayOfData: unknown[] = [];

				if (isM2O) {
					if (typeof fieldChanges === 'number' || typeof fieldChanges === 'string') {
						fieldChanges = { update: [{ id: fieldChanges }] };

						if (typeof oldValObj[key] === 'object') {
							// When saving, fieldChanges will return to the initial value.
							// We must clear cache to obtain the new value after saving.
							fieldCache = {};
							itemCache = {};
						}
					} else if (typeof fieldChanges === 'object') {
						if ('id' in fieldChanges) {
							fieldChanges = { update: [fieldChanges as { id: number | string }] };
						} else {
							fieldChanges = { create: [{ ...fieldChanges }] };
						}
					}
				} else {
					if (fieldChanges instanceof Array && !(oldValObj[key] instanceof Array)) {
						// When saving, fieldChanges will return to the initial value.
						// We must clear cache to obtain the new value after saving.
						fieldCache = {};
						itemCache = {};
					}

					if (pkFinal !== '+') {
						let data;
						if (key in fieldCache) {
							data = fieldCache[key];
						} else {
							data = (await api.get(`items/${collection.value}/${pkFinal}`, {
								params: {
									fields: [key],
								},
							})).data.data[key];
							fieldCache[key] = data;
						}
						arrayOfIds = arrayOfIds.concat(data);
					}

					if (fieldChanges.update) {
						const updatedIds = fieldChanges.update.map(({ id }) => id);
						arrayOfIds = arrayOfIds.filter((id) => !updatedIds.includes(id));
					}

					if (fieldChanges.delete) {
						arrayOfIds = arrayOfIds.filter((id) => !fieldChanges.delete!.includes(id));
					}
				}

				if (fieldChanges.update) {
					arrayOfIds = arrayOfIds.concat(fieldChanges.update.map(({ id }) => id));
				}

				if (arrayOfIds.length) {
					const relatedCollection = isM2O ? relation.related_collection : relation.collection;
					const path = relatedCollection === 'directus_users' ? '/users' : `items/${relatedCollection}`;

					if (relatedCollection) {
						let data;
						if (relatedCollection in itemCache && arrayOfIds.every(id => id in itemCache[relatedCollection])) {
							data = arrayOfIds.map(id => itemCache[relatedCollection][id]);
						} else {
							data = (await api.get(path, {
								params: { filter: { id: { _in: arrayOfIds.join(',') } } },
							})).data.data;
						}

						// merging item updates
						arrayOfData = data.map((item: any) => {
							if (relatedCollection in itemCache) {
								itemCache[relatedCollection][item.id] = item;
							} else {
								itemCache[relatedCollection] = { [item.id]: item };
							}

							return {
								...item,
								...fieldChanges.update?.find(({ id }) => item.id === id),
							};
						});
					}
				}

				// must concat after request, created items doesn't have ids
				if (fieldChanges.create) {
					arrayOfData = arrayOfData.concat(fieldChanges.create);
				}

				relationalData[key] = isM2O ? arrayOfData[0] : arrayOfData;
			}

			finalValues.value = { ...valObj, ...relationalData, __currentUser: userStore.currentUser };
		},
		{
			deep: false,
			immediate: true,
		}
	);

	return finalValues;
};

export const findValueByPath = (obj: Record<string, any>, path: string) => {
	let value = obj;
	for (const i of path.split('.')) {
		if (i in value) {
			value = value[i];
		} else {
			return { value: null, found: false };
		}
	}
	return { value, found: true };
};

export function isString(value: unknown): value is string {
	return typeof value === 'string' || value instanceof String;
}
