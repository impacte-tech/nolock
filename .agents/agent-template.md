---
name: NEW_AGENT
description: |
  Description of what this agent does.
  Replace with a clear, concise purpose statement.
model: YOUR_MODEL_HERE
backend: ollama | openai | anthropic | ...
temperature: 0.7
tools: read_file, list_directory, grep, web_search, web_fetch, write_file, bash
---

# {{name}} Agent

## Description

{{description}}

## Configuration

- **Model**: `{{model}}`
- **Backend**: `{{backend}}`
- **Temperature**: `{{temperature}}`
- **Available Tools**: `{{tools | join(", ")}}`

## How to Invoke

### From Code (hooks.ts)

```typescript
import { resolveAgentPrompt } from "@/lib/hooks";

// Invoke the agent
const prompt = resolveAgentPrompt("{{name}}", {
  // Any context arguments
  query: "your question here"
});

const result = await invokeAI(prompt);
```

### From CLI

```bash
# List available agents
npx nolock agents:list

# Read an agent's system prompt
npx nolock agents:read code-reviewer
```

## Sub-Agent Nesting Rules

- **Max depth**: 4 levels (configurable in `src-tauri/src/main.rs`)
- **Recursion**: Agents should not call themselves recursively beyond 2 levels
- **Scope**: Each nested agent should have a clearly narrower scope than its parent

## Best Practices

1. **Keep descriptions focused** - One agent, one purpose
2. **Specify tools explicitly** - Only grant tools the agent actually needs
3. **Set appropriate temperatures** - Lower (0.1-0.3) for deterministic tasks, higher (0.7-0.9) for creative tasks
4. **Document model choices** - Explain why a particular model/backend was chosen
5. **Include example prompts** - Show what kind of queries work well

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Agent not found" | Ensure the `.md` file exists in `.agents/` with proper YAML frontmatter |
| "Max depth exceeded" | Reduce nesting level or widen the parent agent's scope |
| Unexpected behavior | Check temperature and model selection - try different combinations |

## Adding a New Agent

1. Create a new `.md` file in `.agents/` following this template
2. Fill in all required fields in the YAML frontmatter
3. Add 2-3 example prompts in the "Example Usage" section
4. Run `npm run agents-docs` (if configured) to regenerate any centralized docs