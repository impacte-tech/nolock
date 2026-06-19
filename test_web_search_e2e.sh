#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# End-to-end test: web_search tool with Brave Search + Ollama 4b model
# ──────────────────────────────────────────────────────────────────────────────
# Run this on your Mac M1 with Ollama running:
#   bash test_web_search_e2e.sh
#
# It simulates exactly what nolock's tool loop does:
#   1. Sends user query to Ollama → model makes a tool call
#   2. Executes the tool (Brave Search API)
#   3. Feeds result back to Ollama → model answers
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

MODEL="${1:-oamazonasgabriel/qwen3.5-4b:q3_k_s-8gbGPU}"
BRAVE_KEY="${2:-}"  # Pass as second arg or set BRAVE_API_KEY env var

if [ -z "$BRAVE_KEY" ]; then
  BRAVE_KEY="${BRAVE_API_KEY:-}"
fi

if [ -z "$BRAVE_KEY" ]; then
  echo "❌ No Brave Search API key found."
  echo "   Usage: bash test_web_search_e2e.sh [model] [brave_api_key]"
  echo "   Or set: export BRAVE_API_KEY='BSA-...'"
  exit 1
fi

echo "🔍 Testing web_search with Brave Search + model: $MODEL"
echo ""

# ── Step 1: Get a tool call from the model ──────────────────────────────────
echo "=== STEP 1: Model makes a tool call ==="
STEP1=$(curl -s http://localhost:11434/api/chat -d '{
  "model": "'"$MODEL"'",
  "stream": false,
  "messages": [
    {"role": "system", "content": "You have access to a tool called web_search that searches the internet. You MUST use this tool whenever the user asks a question — ALWAYS search first before answering, even if you think you know the answer. Use the tool, then summarize what you found."},
    {"role": "user", "content": "Search the web for information about the Rust programming language, then summarize what you find."}
  ],
  "tools": [{
    "type": "function",
    "function": {
      "name": "web_search",
      "description": "Search the internet for up-to-date information",
      "parameters": {
        "type": "object",
        "properties": {
          "query": {"type": "string"}
        },
        "required": ["query"]
      }
    }
  }]
}')

TOOL_ID=$(echo "$STEP1" | python3 -c "
import json,sys
d=json.load(sys.stdin)
tc=d.get('message',{}).get('tool_calls',[])
if tc: print(tc[0].get('id','call_unknown'))
else: print('NO_TOOL_CALL')
")

if [ "$TOOL_ID" = "NO_TOOL_CALL" ]; then
  echo "❌ Model did NOT make a tool call"
  echo "   Content: $(echo "$STEP1" | python3 -c "import json,sys;print(repr(json.load(sys.stdin)['message'].get('content',''))[:200])")"
  exit 1
fi

TOOL_ARGS=$(echo "$STEP1" | python3 -c "
import json,sys
d=json.load(sys.stdin)
tc=d['message']['tool_calls']
print(json.dumps(tc[0]['function']['arguments']))
")

echo "✅ Tool call received!"
echo "   Tool ID: $TOOL_ID"
echo "   Args: $TOOL_ARGS"

# ── Step 2: Execute Brave Search API ────────────────────────────────────────
echo ""
echo "=== STEP 2: Brave Search API ==="
QUERY=$(echo "$TOOL_ARGS" | python3 -c "import json,sys;print(json.load(sys.stdin).get('query','Rust programming language'))")
echo "   Query: $QUERY"

ENCODED_QUERY=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$QUERY'))")
BRAVE_RESPONSE=$(curl -s --compressed "https://api.search.brave.com/res/v1/web/search?q=$ENCODED_QUERY&count=10" \
  -H "Accept: application/json" \
  -H "Accept-Encoding: gzip" \
  -H "X-Subscription-Token: $BRAVE_KEY")

# Parse and format results
TOOL_RESULT=$(echo "$BRAVE_RESPONSE" | python3 -c "
import json,sys
data=json.load(sys.stdin)
results=[]
for r in data.get('web',{}).get('results',[])[:8]:
    t=r.get('title','')
    u=r.get('url','')
    d=r.get('description','')
    if d: results.append(f'{t} - {d} - {u}')
    else: results.append(f'{t} - {u}')
print('\n'.join(results) if results else 'No results found.')
")

RESULT_COUNT=$(echo "$BRAVE_RESPONSE" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('web',{}).get('results',[])))")
echo "   Results from Brave: $RESULT_COUNT"
echo "   Preview: ${TOOL_RESULT:0:300}"

if [ "$RESULT_COUNT" -eq 0 ]; then
  echo "❌ Brave Search returned no results"
  echo "$BRAVE_RESPONSE" | python3 -m json.tool 2>/dev/null | head -20
  exit 1
fi

# ── Step 3: Feed result back to model ───────────────────────────────────────
echo ""
echo "=== STEP 3: Model responds with tool result ==="

FINAL=$(curl -s http://localhost:11434/api/chat -d "{
  \"model\": \"$MODEL\",
  \"stream\": false,
  \"messages\": [
    {\"role\": \"system\", \"content\": \"You have access to tools: web_search. Always search first, then answer.\"},
    {\"role\": \"user\", \"content\": \"Search the web for information about the Rust programming language, then summarize.\"},
    {\"role\": \"assistant\", \"content\": \"\", \"tool_calls\": [{\"id\": \"$TOOL_ID\", \"function\": {\"name\": \"web_search\", \"arguments\": $TOOL_ARGS}}]},
    {\"role\": \"tool\", \"tool_call_id\": \"$TOOL_ID\", \"content\": $(echo "$TOOL_RESULT" | python3 -c "import json,sys;print(json.dumps(sys.stdin.read()))")}
  ],
  \"tools\": [{
    \"type\": \"function\",
    \"function\": {
      \"name\": \"web_search\",
      \"description\": \"Search the internet\",
      \"parameters\": {
        \"type\": \"object\",
        \"properties\": {
          \"query\": {\"type\": \"string\"}
        },
        \"required\": [\"query\"]
      }
    }
  }]
}")

FINAL_CONTENT=$(echo "$FINAL" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d.get('message',{}).get('content',''))
")

echo "   Response: ${FINAL_CONTENT:0:500}"
echo ""

# ── Verify ──────────────────────────────────────────────────────────────────
HAS_RESULT=$(echo "$FINAL_CONTENT" | python3 -c "
import sys
content=sys.stdin.read()
keywords=['Rust','programming','performance','memory','safe','type','concurrency']
matches=[k for k in keywords if k.lower() in content.lower()]
print(len(matches))
")

if [ "$HAS_RESULT" -ge 3 ]; then
  echo "✅ PASS: Model used Brave Search results and answered meaningfully"
  echo "   (matched $HAS_RESULT/7 key terms from Brave results)"
elif [ "$HAS_RESULT" -ge 1 ]; then
  echo "⚠️  PARTIAL: Model referenced some Brave results (matched $HAS_RESULT/7 terms)"
else
  echo "❌ FAIL: Model did not reference Brave Search results"
  echo "   The tool_call_id or result format may still have issues"
fi

echo ""
echo "=== Test complete ==="
