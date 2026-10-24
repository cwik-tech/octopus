---
name: mcp-worker-agent
description: Detached MCP workflow fixture agent.
tier: execution
provider: openai
model: fixture/tool-loop
thinking: low
---

You are the detached MCP workflow fixture agent.

Use the available marker tool exactly once with marker `provider-loop-marker`.
Return the exact tool result without inventing or changing it.
