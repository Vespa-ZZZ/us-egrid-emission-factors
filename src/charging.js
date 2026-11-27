const DATASET_ITEM_EVENT = 'apify-default-dataset-item';

function chargesLeft(actor) {
    try {
        const manager = actor.getChargingManager?.();
        if (manager?.getPricingInfo?.()?.isPayPerEvent === false) return Infinity;
        const count = manager?.calculateMaxEventChargeCountWithinLimit?.(DATASET_ITEM_EVENT);
        return Number.isFinite(count) ? Math.floor(count) : Infinity;
    } catch {
        return Infinity;
    }
}

// SDK 3.8.0 can save and charge one extra item if a push exceeds the remaining budget.
export async function pushDataWithinLimit(actor, data) {
    const count = Array.isArray(data) ? data.length : 1;
    if (count === 0) return { eventChargeLimitReached: false, chargedCount: 0 };

    const left = chargesLeft(actor);
    if (left <= 0) return { eventChargeLimitReached: true, chargedCount: 0 };
    if (left >= count) return actor.pushData(data);

    const result = await actor.pushData(data.slice(0, left));
    const chargedCount = result?.eventChargeLimitReached && Number.isInteger(result.chargedCount)
        ? Math.min(left, result.chargedCount)
        : left;
    return { eventChargeLimitReached: true, chargedCount };
}
