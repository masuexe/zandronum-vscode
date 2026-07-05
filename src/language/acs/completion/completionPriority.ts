export enum CompletionPriority {
    LocalVariable = 50,
    Enum = 100,
    Constant = 200,
    Function = 300,
    Keyword = 400,
    Snippet = 500,
}

export function makeSortText(priority: CompletionPriority, label: string): string {
    return String(priority).padStart(3, '0') + '_' + label;
}
