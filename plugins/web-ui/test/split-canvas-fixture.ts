export function twoPaneCanvas(a: Record<string, string>, b: Record<string, string>): object {
  return {
    v: 2,
    active: true,
    layout: {
      grid: {
        root: {
          type: "branch",
          data: [
            { type: "leaf", data: { views: ["a"], activeView: "a", id: "ga" } },
            { type: "leaf", data: { views: ["b"], activeView: "b", id: "gb" } },
          ],
        },
        width: 1000,
        height: 800,
        orientation: "HORIZONTAL",
      },
      panels: Object.fromEntries(
        Object.entries({ a, b }).map(([id, params]) => [
          id,
          { id, contentComponent: "pane", tabComponent: "pane", params, title: "Conversation" },
        ]),
      ),
      activeGroup: "ga",
    },
  };
}
