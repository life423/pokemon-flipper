// Browse includes the same list of possible flaws on every card in each of
// these condition categories. Match the whole category-specific list so an
// isolated, listing-specific disclosure remains evidence.
const examples: Record<string, string[]> = {
    "near mint or better": ["minor corner and edge wear"],
    "lightly played (excellent)": ["moderate surface scuffing", "fuzzy corners", "moderate edge chipping"],
    "moderately played (very good)": ["moderate creasing", "moderate to heavy edge chipping", "rounding and soft corner", "moderate discoloration"],
    "heavily played (poor)": ["major creasing", "moderate discoloration", "major border wear", "heavily worn and rounded corners"],
};

export function cardSpecificNotes(condition: string | null | undefined, notes: string[]): string[] {
    const key = condition?.trim().toLowerCase() ?? "";
    if (!Object.hasOwn(examples, key)) return notes;
    const template = examples[key];
    if (notes.length < template.length) return notes;
    const normalized = notes.map(note => note.trim().toLowerCase().replace("discolouration", "discoloration"));
    const indices = template.map(example => normalized.indexOf(example));
    return indices.includes(-1) ? notes : notes.filter((_, index) => !indices.includes(index));
}

export function hasSavedConditionExamples(listing: { cardCondition?: string | null; conditionNotes?: string[] }): boolean {
    const notes = listing.conditionNotes;
    return !!notes && cardSpecificNotes(listing.cardCondition, notes) !== notes;
}
