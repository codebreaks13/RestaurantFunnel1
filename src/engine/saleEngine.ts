import type { Ingredient, MenuItem, OrderItem, RecipeIngredient } from '../types';
import { money, generateId } from './orderEngine.ts';
import { resolveItemRecipe, validateRecipeLines } from './recipeEngine.ts';
/**
 * Turning a till ticket into priced, costed order lines.
 *
 * WHY THIS IS A SEPARATE PURE MODULE
 * This logic used to sit inside `confirmSale` in RestaurantContext, where it
 * could not be tested and where every unrecognised input was skipped instead of
 * refused:
 *
 *  - an unknown `menuItemId` hit `if (!menuItem) continue;`, so the line silently
 *    vanished from the ticket while the customer had ordered it;
 *  - an unknown `variationId` or `modifierId` was ignored, so the sale was priced
 *    as the plain dish and `resolveItemRecipe` fell back to the FIRST variation's
 *    recipe -- wrong money and wrong stock;
 *  - `quantity` was never checked, so 0, -3, 2.5 and NaN all reached the ledger;
 *  - archived and unavailable dishes could still be sold;
 *  - a recipe line pointing at a deleted ingredient, or measured in an
 *    incompatible unit, resolved at zero cost and deducted nothing.
 *
 * Every one of those is now a rejection. The rule is that the business layer
 * decides what a valid ticket is; the till is just one possible caller.
 */
export interface SaleLineInput {
    menuItemId: string;
    variationId?: string;
    modifierIds?: string[];
    quantity: number;
    notes?: string;
}
export interface BuiltSaleLines {
    items: OrderItem[];
    /** Aggregated stock requirement across the whole ticket, in ingredient units. */
    deductionNeeds: {
        ingredientId: string;
        quantity: number;
    }[];
}
export type BuildSaleLinesResult = ({
    ok: true;
} & BuiltSaleLines) | {
    ok: false;
    error: string;
    missingRecipes?: string[];
};
const reject = (error: string, missingRecipes?: string[]): BuildSaleLinesResult => missingRecipes ? { ok: false, error, missingRecipes } : { ok: false, error };
/** Quantities are whole portions: half a burger is not a thing the till sells. */
function quantityProblem(quantity: unknown, dishName: string): string | null {
    if (typeof quantity !== 'number' || !Number.isFinite(quantity)) {
        return `Quantity for ${dishName} is not a number.`;
    }
    if (quantity <= 0)
        return `Quantity for ${dishName} must be at least 1.`;
    if (!Number.isInteger(quantity))
        return `Quantity for ${dishName} must be a whole number.`;
    return null;
}
export function buildSaleLines(input: {
    lines: SaleLineInput[];
    menuItems: MenuItem[];
    ingredientsMap: Map<string, Ingredient>;
    /** Injectable so tests can assert on stable ids. */
    makeItemId?: () => string;
}): BuildSaleLinesResult {
    const { lines, menuItems, ingredientsMap } = input;
    const makeItemId = input.makeItemId ?? (() => generateId('item'));
    if (!Array.isArray(lines) || lines.length === 0) {
        return reject('Cannot record an empty order.');
    }
    const menuById = new Map(menuItems.map((m) => [m.id, m]));
    const items: OrderItem[] = [];
    const needs = new Map<string, number>();
    const itemsWithoutRecipe: string[] = [];
    for (const line of lines) {
        const menuItem = menuById.get(line.menuItemId);
        if (!menuItem) {
            return reject(`That dish is no longer on the menu (${line.menuItemId}). Remove it and try again.`);
        }
        if (menuItem.isArchived) {
            return reject(`${menuItem.name} has been removed from the menu and cannot be sold.`);
        }
        if (menuItem.isAvailable === false) {
            return reject(`${menuItem.name} is marked unavailable and cannot be sold.`);
        }
        const quantityError = quantityProblem(line.quantity, menuItem.name);
        if (quantityError)
            return reject(quantityError);
        let unitPrice = menuItem.basePrice;
        if (!Number.isFinite(unitPrice) || unitPrice < 0) {
            return reject(`${menuItem.name} has no usable price. Fix it in menu management first.`);
        }
        /**
         * A dish with sizes must be sold as one of them. Picking the first size on
         * the operator's behalf is how a small pizza used to be charged -- and
         * costed -- as whatever size happened to be listed first.
         */
        const variations = menuItem.variations ?? [];
        let variationName: string | undefined;
        if (line.variationId !== undefined) {
            const variation = variations.find((v) => v.id === line.variationId);
            if (!variation) {
                return reject(`${menuItem.name} has no option "${line.variationId}".`);
            }
            unitPrice += variation.additionalPrice;
            variationName = variation.name;
        }
        else if (variations.length > 0) {
            return reject(`Choose a size for ${menuItem.name}.`);
        }
        const activeModifiers: {
            modifierId: string;
            name: string;
            price: number;
        }[] = [];
        for (const modifierId of line.modifierIds ?? []) {
            const modifier = (menuItem.modifiers ?? []).find((m) => m.id === modifierId);
            if (!modifier) {
                return reject(`${menuItem.name} has no extra "${modifierId}".`);
            }
            unitPrice += modifier.additionalPrice;
            activeModifiers.push({
                modifierId: modifier.id,
                name: modifier.name,
                price: modifier.additionalPrice,
            });
        }
        // Validate every recipe that will actually be consumed, before any of it is
        // converted or costed.
        const recipesToCheck: {
            label: string;
            recipe: RecipeIngredient[];
        }[] = [];
        const selectedVariation = variations.find((v) => v.id === line.variationId);
        if (selectedVariation && (selectedVariation.recipe?.length ?? 0) > 0) {
            recipesToCheck.push({
                label: `${menuItem.name} (${selectedVariation.name})`,
                recipe: selectedVariation.recipe,
            });
        }
        else {
            recipesToCheck.push({ label: menuItem.name, recipe: menuItem.recipe ?? [] });
        }
        for (const modifier of activeModifiers) {
            const full = (menuItem.modifiers ?? []).find((m) => m.id === modifier.modifierId);
            if (full && (full.recipe?.length ?? 0) > 0) {
                recipesToCheck.push({ label: `${menuItem.name} + ${full.name}`, recipe: full.recipe });
            }
        }
        for (const entry of recipesToCheck) {
            const problems = validateRecipeLines(entry.recipe, ingredientsMap, entry.label);
            if (problems.length > 0) {
                return reject(problems[0].reason);
            }
        }
        const resolvedRecipe = resolveItemRecipe(menuItem, line.variationId, line.modifierIds ?? [], ingredientsMap);
        /**
         * A dish with no recipe would sell at zero cost and consume no stock,
         * silently inflating profit. The owner must define portions first.
         */
        if (resolvedRecipe.length === 0) {
            itemsWithoutRecipe.push(menuItem.name);
            continue;
        }
        let unitCogs = 0;
        const consumedIngredients = resolvedRecipe.map((resolved) => {
            unitCogs += resolved.costImpact;
            const needed = resolved.quantityInIngredientUnit * line.quantity;
            needs.set(resolved.ingredientId, (needs.get(resolved.ingredientId) ?? 0) + needed);
            return {
                ingredientId: resolved.ingredientId,
                ingredientName: resolved.ingredientName,
                quantity: resolved.quantityInIngredientUnit,
                unit: resolved.unit,
            };
        });
        items.push({
            id: makeItemId(),
            menuItemId: menuItem.id,
            menuItemName: menuItem.name,
            variationId: line.variationId,
            variationName,
            modifiers: activeModifiers,
            unitPrice: money(unitPrice),
            quantity: line.quantity,
            subtotal: money(unitPrice * line.quantity),
            itemCogs: money(unitCogs * line.quantity),
            consumedIngredients,
            notes: line.notes,
        });
    }
    if (itemsWithoutRecipe.length > 0) {
        return reject(`No recipe defined for: ${itemsWithoutRecipe.join(', ')}. Set the portions before selling these.`, itemsWithoutRecipe);
    }
    return {
        ok: true,
        items,
        deductionNeeds: Array.from(needs.entries()).map(([ingredientId, quantity]) => ({
            ingredientId,
            quantity,
        })),
    };
}
