#!/usr/bin/env python3
"""Test the full tool chain: web_search -> web_fetch -> model responds"""

import json, urllib.request, urllib.parse, sys, gzip, io

MODEL = "oamazonasgabriel/qwen3.5-4b:q3_k_s-8gbGPU"
BRAVE_KEY = "BSA1VKerunNwPfZThRTLXQFFAKVo956"
OLLAMA_URL = "http://localhost:11434/api/chat"


def ollama_chat(body):
    req = urllib.request.Request(
        OLLAMA_URL,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())


def brave_search(query):
    import gzip, io

    encoded = urllib.parse.quote(query)
    url = f"https://api.search.brave.com/res/v1/web/search?q={encoded}&count=10"
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": BRAVE_KEY,
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read()
        # Decompress gzip if needed
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        data = json.loads(raw)
    results = []
    for r in data.get("web", {}).get("results", [])[:8]:
        t = r.get("title", "")
        u = r.get("url", "")
        d = r.get("description", "")
        if d:
            results.append(f"{t} - {d} - {u}")
        else:
            results.append(f"{t} - {u}")
    return "\n".join(results) if results else "No results found."


def duckduckgo_search(query):
    url = f"https://api.duckduckgo.com/?q={urllib.parse.quote(query)}&format=json&no_html=1&skip_disambig=1&t=nolock"
    req = urllib.request.Request(url, headers={"User-Agent": "nolock/0.1"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())
    results = []
    at = data.get("AbstractText", "")
    if at:
        results.append(f"[Summary] {at}")

    def extract(topics, out, depth=0):
        if depth > 3:
            return
        for t in topics:
            if "Text" in t:
                out.append(f"{t['Text']} - {t.get('FirstURL', '(no URL)')}")
            if "Topics" in t:
                extract(t["Topics"], out, depth + 1)

    extract(data.get("RelatedTopics", []), results, 0)
    if not results:
        return None  # No results
    return "\n".join(results)


tools = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the internet for up-to-date information",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_fetch",
            "description": "Fetch and read web page content from a specific URL",
            "parameters": {
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": ["url"],
            },
        },
    },
]

# ===== TEST 1: Brave Search =====
print("=" * 60)
print("TEST 1: Brave Search + model")
print("=" * 60)

messages = [
    {
        "role": "system",
        "content": "You have access to tools: web_search and web_fetch. Use web_search to find URLs, then web_fetch to read pages.",
    },
    {"role": "user", "content": "What is the AWS Kinesis Firehose documentation URL?"},
]

# Round 1: Get tool call
resp1 = ollama_chat(
    {"model": MODEL, "stream": False, "messages": messages, "tools": tools}
)
tc1 = resp1.get("message", {}).get("tool_calls", [])
if not tc1:
    print("FAIL: Model did not make a tool call")
    print(f"  Content: {resp1.get('message', {}).get('content', '')[:200]}")
    sys.exit(1)

name1 = tc1[0]["function"]["name"]
args1 = tc1[0]["function"]["arguments"]
id1 = tc1[0].get("id", "call_unknown")
print(f"Round 1: {name1}({json.dumps(args1)})")

# Execute tool
if name1 == "web_search":
    query = args1.get("query", "")
    result1 = brave_search(query)
    print(f"  Query: {query}")
    print(f"  Results: {result1[:200]}...")
else:
    url = args1.get("url", "")
    print(f"  Fetching: {url}")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "nolock/0.1"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            content = resp.read().decode("utf-8", errors="replace")
        result1 = content[:15000] if len(content) > 15000 else content
        print(f"  Got {len(content)} chars")
    except Exception as e:
        result1 = f"Failed to fetch URL: {e}"
        print(f"  Error: {e}")

# Round 2: Feed result back
messages.append(
    {
        "role": "assistant",
        "content": "",
        "tool_calls": [{"id": id1, "function": {"name": name1, "arguments": args1}}],
    }
)
messages.append({"role": "tool", "tool_call_id": id1, "content": result1})

resp2 = ollama_chat(
    {"model": MODEL, "stream": False, "messages": messages, "tools": tools}
)
tc2 = resp2.get("message", {}).get("tool_calls", [])
content2 = resp2.get("message", {}).get("content", "")

if tc2:
    for t in tc2:
        print(
            f"\nRound 2: {t['function']['name']}({json.dumps(t['function']['arguments'])})"
        )
        # Execute the second tool
        name2 = t["function"]["name"]
        args2 = t["function"]["arguments"]
        id2 = t.get("id", "call_unknown")

        if name2 == "web_fetch":
            url = args2.get("url", "")
            print(f"  Fetching: {url}")
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "nolock/0.1"})
                with urllib.request.urlopen(req, timeout=15) as resp:
                    content = resp.read().decode("utf-8", errors="replace")
                result2 = content[:15000] if len(content) > 15000 else content
                print(f"  Got {len(content)} chars")
            except Exception as e:
                result2 = f"HTTP error or network issue: {e}"
                print(f"  Error: {e}")
        else:
            result2 = f"Unknown tool {name2}"

        # Round 3: Feed second result back
        messages.append(
            {
                "role": "assistant",
                "content": content2,
                "tool_calls": [
                    {"id": id2, "function": {"name": name2, "arguments": args2}}
                ],
            }
        )
        messages.append({"role": "tool", "tool_call_id": id2, "content": result2})

        resp3 = ollama_chat(
            {"model": MODEL, "stream": False, "messages": messages, "tools": tools}
        )
        content3 = resp3.get("message", {}).get("content", "")
        tc3 = resp3.get("message", {}).get("tool_calls", [])
        if tc3:
            print(f"Round 3: Another tool call: {tc3[0]['function']['name']}")
        else:
            print(f"\nRound 3 (final): {content3[:500]}")
else:
    print(f"\nRound 2 (final): {content2[:500]}")

# ===== TEST 2: DuckDuckGo (no results path) =====
print("\n" + "=" * 60)
print("TEST 2: DuckDuckGo (no results) + model")
print("=" * 60)

ddg_result = duckduckgo_search("AWS Kinesis Firehose documentation URL")
if ddg_result is None:
    error_msg = "DuckDuckGo Instant Answer API returned no results. This API is experimental and limited."
    print(f"DuckDuckGo returned NO results")

    messages2 = [
        {
            "role": "system",
            "content": "You have access to tools: web_search and web_fetch.",
        },
        {
            "role": "user",
            "content": "What is the AWS Kinesis Firehose documentation URL?",
        },
    ]

    resp1 = ollama_chat(
        {"model": MODEL, "stream": False, "messages": messages2, "tools": tools}
    )
    tc1 = resp1.get("message", {}).get("tool_calls", [])
    if tc1:
        id1 = tc1[0].get("id", "call_unknown")
        name1 = tc1[0]["function"]["name"]
        args1 = tc1[0]["function"]["arguments"]

        messages2.append(
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": id1, "function": {"name": name1, "arguments": args1}}
                ],
            }
        )
        messages2.append({"role": "tool", "tool_call_id": id1, "content": error_msg})

        resp2 = ollama_chat(
            {"model": MODEL, "stream": False, "messages": messages2, "tools": tools}
        )
        content2 = resp2.get("message", {}).get("content", "")
        tc2 = resp2.get("message", {}).get("tool_calls", [])
        if tc2:
            print(f"Model made another tool call: {tc2[0]['function']['name']}")
            # Check if it's a web_fetch to a guessed URL
            if tc2[0]["function"]["name"] == "web_fetch":
                guessed_url = tc2[0]["function"]["arguments"].get("url", "")
                print(f"  Guessed URL: {guessed_url}")
                # Try fetching it
                try:
                    req = urllib.request.Request(
                        guessed_url, headers={"User-Agent": "nolock/0.1"}
                    )
                    with urllib.request.urlopen(req, timeout=15) as resp:
                        fetch_content = resp.read().decode("utf-8", errors="replace")
                    print(f"  Fetch OK: {len(fetch_content)} chars")
                except Exception as e:
                    print(f"  Fetch FAILED: {e}")
        else:
            print(f"Model response: {content2[:500]}")
    else:
        print(
            f"Model did not make tool call: {resp1.get('message', {}).get('content', '')[:200]}"
        )
else:
    print(f"DuckDuckGo returned: {ddg_result[:200]}")

print("\n" + "=" * 60)
print("Tests complete")
print("=" * 60)
