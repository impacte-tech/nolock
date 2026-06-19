#!/usr/bin/env python3
"""Test how the model handles various error responses from tools"""

import json, urllib.request, sys

MODEL = "oamazonasgabriel/qwen3.5-4b:q3_k_s-8gbGPU"
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


tools = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the internet",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    }
]

# Test: Model gets "no results" from DuckDuckGo
print("=" * 60)
print("TEST: Model receives 'no results' error")
print("=" * 60)

error_msg = "DuckDuckGo Instant Answer API returned no results. This API is experimental and limited - try enabling Brave Search in AI Integrations settings for real web search results."

# First get a tool call
resp1 = ollama_chat(
    {
        "model": MODEL,
        "stream": False,
        "messages": [
            {"role": "system", "content": "You have access to tools: web_search."},
            {
                "role": "user",
                "content": "What is the AWS Kinesis Firehose documentation URL?",
            },
        ],
        "tools": tools,
    }
)

tc = resp1.get("message", {}).get("tool_calls", [])
if tc:
    tc_id = tc[0].get("id", "call_unknown")
    tc_name = tc[0]["function"]["name"]
    tc_args = tc[0]["function"]["arguments"]

    resp2 = ollama_chat(
        {
            "model": MODEL,
            "stream": False,
            "messages": [
                {"role": "system", "content": "You have access to tools: web_search."},
                {
                    "role": "user",
                    "content": "What is the AWS Kinesis Firehose documentation URL?",
                },
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": tc_id,
                            "function": {"name": tc_name, "arguments": tc_args},
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": tc_id, "content": error_msg},
            ],
            "tools": tools,
        }
    )

    content = resp2.get("message", {}).get("content", "")
    tc2 = resp2.get("message", {}).get("tool_calls", [])

    print(f"Model content: {content[:400]}")
    if tc2:
        for t in tc2:
            print(
                f"Model made ANOTHER tool call: {t['function']['name']}({json.dumps(t['function']['arguments'])})"
            )
    print()

    # Round 3: Check if it loops again
    if tc2:
        tc_id2 = tc2[0].get("id", "call_unknown")
        tc_name2 = tc2[0]["function"]["name"]
        tc_args2 = tc2[0]["function"]["arguments"]

        resp3 = ollama_chat(
            {
                "model": MODEL,
                "stream": False,
                "messages": [
                    {
                        "role": "system",
                        "content": "You have access to tools: web_search.",
                    },
                    {
                        "role": "user",
                        "content": "What is the AWS Kinesis Firehose documentation URL?",
                    },
                    {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [
                            {
                                "id": tc_id,
                                "function": {"name": tc_name, "arguments": tc_args},
                            }
                        ],
                    },
                    {"role": "tool", "tool_call_id": tc_id, "content": error_msg},
                    {
                        "role": "assistant",
                        "content": content,
                        "tool_calls": [
                            {
                                "id": tc_id2,
                                "function": {"name": tc_name2, "arguments": tc_args2},
                            }
                        ],
                    },
                    {"role": "tool", "tool_call_id": tc_id2, "content": error_msg},
                ],
                "tools": tools,
            }
        )

        content3 = resp3.get("message", {}).get("content", "")
        tc3 = resp3.get("message", {}).get("tool_calls", [])
        print(f"Round 3 content: {content3[:400]}")
        if tc3:
            print(f"STILL LOOPING! Another tool call: {tc3[0]['function']['name']}")
else:
    print("No tool call from model")

# Test: Rate limit error
print("=" * 60)
print("TEST: Model receives rate limit error (HTTP 429)")
print("=" * 60)

rate_limit_msg = "Brave Search API error (HTTP 429): Request rate limit exceeded for Free plan. Max 1 request/second."

resp1b = ollama_chat(
    {
        "model": MODEL,
        "stream": False,
        "messages": [
            {"role": "system", "content": "You have access to tools: web_search."},
            {
                "role": "user",
                "content": "What is the AWS Kinesis Firehose documentation URL?",
            },
        ],
        "tools": tools,
    }
)

tc1b = resp1b.get("message", {}).get("tool_calls", [])
if tc1b:
    tc_id = tc1b[0].get("id", "call_unknown")
    tc_name = tc1b[0]["function"]["name"]
    tc_args = tc1b[0]["function"]["arguments"]

    resp2b = ollama_chat(
        {
            "model": MODEL,
            "stream": False,
            "messages": [
                {"role": "system", "content": "You have access to tools: web_search."},
                {
                    "role": "user",
                    "content": "What is the AWS Kinesis Firehose documentation URL?",
                },
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": tc_id,
                            "function": {"name": tc_name, "arguments": tc_args},
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": tc_id, "content": rate_limit_msg},
            ],
            "tools": tools,
        }
    )

    content = resp2b.get("message", {}).get("content", "")
    tc2b = resp2b.get("message", {}).get("tool_calls", [])
    print(f"Model content: {content[:400]}")
    if tc2b:
        print(f"Model made another tool call: {tc2b[0]['function']['name']}")
    print()
else:
    print("No tool call from model")

# Test: What does the model do with the success message
print("=" * 60)
print("TEST: Model receives successful Brave Search results")
print("=" * 60)

success_msg = """1. What is Amazon Data Firehose? - Amazon Data Firehose - Producers send records to Firehose streams. For example, a web server that sends log data to a Firehose stream is a data producer. You can also configure your Firehose stream to automatically read data from an existing Kinesis data stream - https://docs.aws.amazon.com/firehose/latest/dev/what-is-this-service.html

2. Welcome - Amazon Data Firehose - https://docs.aws.amazon.com/firehose/latest/APIReference/Welcome.html

3. Configure Kinesis agent to send data - Amazon Data Firehose - https://docs.aws.amazon.com/firehose/latest/dev/writing-with-agents.html

4. AWS::KinesisFirehose::DeliveryStream - AWS CloudFormation - https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-kinesisfirehose-deliverystream.html

[Search powered by Brave Search]"""

resp1c = ollama_chat(
    {
        "model": MODEL,
        "stream": False,
        "messages": [
            {
                "role": "system",
                "content": "You have access to tools: web_search and web_fetch.",
            },
            {
                "role": "user",
                "content": "What is the AWS Kinesis Firehose documentation URL?",
            },
        ],
        "tools": tools,
    }
)

tc1c = resp1c.get("message", {}).get("tool_calls", [])
if tc1c:
    tc_id = tc1c[0].get("id", "call_unknown")

    resp2c = ollama_chat(
        {
            "model": MODEL,
            "stream": False,
            "messages": [
                {
                    "role": "system",
                    "content": "You have access to tools: web_search and web_fetch.",
                },
                {
                    "role": "user",
                    "content": "What is the AWS Kinesis Firehose documentation URL?",
                },
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": tc_id,
                            "function": {
                                "name": "web_search",
                                "arguments": {
                                    "query": "AWS Kinesis Firehose documentation URL"
                                },
                            },
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": tc_id, "content": success_msg},
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "web_search",
                        "description": "Search",
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
                        "description": "Fetch a URL",
                        "parameters": {
                            "type": "object",
                            "properties": {"url": {"type": "string"}},
                            "required": ["url"],
                        },
                    },
                },
            ],
        }
    )

    content = resp2c.get("message", {}).get("content", "")
    tc2c = resp2c.get("message", {}).get("tool_calls", [])
    print(f"Model content: {content[:500]}")
    if tc2c:
        for t in tc2c:
            print(
                f"Model made another tool call: {t['function']['name']}({json.dumps(t['function']['arguments'])})"
            )
    print()

print("=== Done ===")
