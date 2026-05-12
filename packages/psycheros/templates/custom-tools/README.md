# Custom Tools

Place `.js` files in this directory to add custom tools to the entity. Each file
must export a default `Tool` object.

## Tool Interface

```javascript
export default {
  definition: {
    type: "function",
    function: {
      name: "my_custom_tool",
      description: "What this tool does, shown to the entity",
      parameters: {
        type: "object",
        properties: {
          // Define your parameters as JSON Schema
          input: {
            type: "string",
            description: "The input text",
          },
        },
        required: ["input"],
      },
    },
  },
  execute: async (args, ctx) => {
    // args: parsed arguments from the LLM
    // ctx: { toolCallId, conversationId, db, config }
    // config.projectRoot is the project root directory

    const result = doSomething(args.input);

    return {
      content: `Result: ${result}`,
    };
  },
};
```

## Enabling

After placing a `.js` file here, restart the server. The tool will appear in
Settings > Tools under the "Custom Tools" section. Toggle it on to enable it for
the entity.

## Notes

- File names don't matter; the tool name comes from `definition.function.name`.
- Invalid files are logged as warnings and skipped.
- Tools have access to the database (`ctx.db`) and project root
  (`ctx.config.projectRoot`).
