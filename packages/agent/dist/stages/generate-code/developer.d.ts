declare function parseTaskGroups(tasksMarkdown: string): Array<{
    title: string;
    content: string;
    files: string[];
}>;
/**
 * Run Developer Agent — writes code directly to local repo.
 */
declare function runDeveloperAgent(ctx: any): Promise<void>;
export { runDeveloperAgent, parseTaskGroups };
//# sourceMappingURL=developer.d.ts.map