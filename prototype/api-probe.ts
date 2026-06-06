/**
 * api-probe.ts — Probe OpenCode-Go API to validate usage data format
 *
 * This prototype makes REAL HTTP requests to OpenCode-Go and shows:
 * 1. Non-streaming response structure (usage field)
 * 2. Streaming SSE chunks (final usage chunk)
 * 3. Error responses when quota is exhausted (if we can trigger it)
 *
 * Run with: npm run proto:probe
 *
 * Requires: api_keys.txt with format "label - sk-..."
 */

import { readFileSync } from 'node:fs';

const ANSI = {
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  YELLOW: '\x1b[33m',
  CYAN: '\x1b[36m',
  RESET: '\x1b[0m',
};

interface KeyEntry {
  label: string;
  key: string;
}

function loadKeys(filePath: string): KeyEntry[] {
  const raw = readFileSync(filePath, 'utf-8');
  const entries: KeyEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sepIndex = trimmed.indexOf(' - ');
    if (sepIndex === -1) continue;
    const label = trimmed.slice(0, sepIndex).trim();
    const key = trimmed.slice(sepIndex + 3).trim();
    if (label && key) entries.push({ label, key });
  }
  return entries;
}

function maskKey(key: string): string {
  if (key.length <= 8) return key;
  return key.slice(0, 4) + '...' + key.slice(-4);
}

async function probeNonStreaming(key: KeyEntry): Promise<void> {
  console.log('\n' + ANSI.BOLD + ANSI.CYAN + '=== NON-STREAMING REQUEST ===' + ANSI.RESET);
  console.log('Key: ' + key.label + ' (' + maskKey(key.key) + ')');
  console.log('Model: glm-5');
  console.log('Request body:');
  console.log(JSON.stringify({
    model: 'glm-5',
    messages: [{ role: 'user', content: 'Say "hello" in exactly 3 words.' }],
    max_tokens: 20,
    stream: false,
  }, null, 2));

  console.log('\n' + ANSI.DIM + 'Sending request...' + ANSI.RESET);

  try {
    const response = await fetch('https://opencode.ai/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key.key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'glm-5',
        messages: [{ role: 'user', content: 'Say "hello" in exactly 3 words.' }],
        max_tokens: 20,
        stream: false,
      }),
    });

    console.log('\n' + ANSI.BOLD + 'Response Status:' + ANSI.RESET + ' ' + response.status);
    console.log(ANSI.BOLD + 'Response Headers:' + ANSI.RESET);
    for (const [name, value] of response.headers.entries()) {
      console.log('  ' + name + ': ' + value);
    }

    const body = await response.text();
    console.log('\n' + ANSI.BOLD + 'Response Body:' + ANSI.RESET);
    
    try {
      const json = JSON.parse(body);
      console.log(JSON.stringify(json, null, 2));
      
      if (json.usage) {
        console.log('\n' + ANSI.GREEN + ANSI.BOLD + '✓ USAGE FIELD FOUND:' + ANSI.RESET);
        console.log('  prompt_tokens: ' + json.usage.prompt_tokens);
        console.log('  completion_tokens: ' + json.usage.completion_tokens);
        console.log('  total_tokens: ' + json.usage.total_tokens);
      } else {
        console.log('\n' + ANSI.RED + ANSI.BOLD + '✗ NO USAGE FIELD' + ANSI.RESET);
      }

      if (json.cost !== undefined) {
        console.log('\n' + ANSI.GREEN + '✓ COST FIELD FOUND: ' + json.cost + ANSI.RESET);
      }
    } catch {
      console.log(body);
    }
  } catch (err) {
    console.log(ANSI.RED + 'ERROR: ' + (err instanceof Error ? err.message : String(err)) + ANSI.RESET);
  }
}

async function probeStreaming(key: KeyEntry, withStreamOptions: boolean = false): Promise<void> {
  console.log('\n' + ANSI.BOLD + ANSI.CYAN + '=== STREAMING REQUEST' + (withStreamOptions ? ' (with stream_options)' : '') + ' ===' + ANSI.RESET);
  console.log('Key: ' + key.label + ' (' + maskKey(key.key) + ')');
  console.log('Model: glm-5');
  
  const requestBody: any = {
    model: 'glm-5',
    messages: [{ role: 'user', content: 'Count from 1 to 5.' }],
    max_tokens: 50,
    stream: true,
  };
  
  if (withStreamOptions) {
    requestBody.stream_options = { include_usage: true };
  }
  
  console.log('Request body:');
  console.log(JSON.stringify(requestBody, null, 2));

  console.log('\n' + ANSI.DIM + 'Sending request...' + ANSI.RESET);

  try {
    const response = await fetch('https://opencode.ai/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key.key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    console.log('\n' + ANSI.BOLD + 'Response Status:' + ANSI.RESET + ' ' + response.status);
    console.log(ANSI.BOLD + 'Content-Type:' + ANSI.RESET + ' ' + response.headers.get('content-type'));

    if (!response.ok) {
      const body = await response.text();
      console.log('\n' + ANSI.BOLD + 'Error Body:' + ANSI.RESET);
      console.log(body);
      return;
    }

    if (!response.body) {
      console.log(ANSI.RED + 'No response body' + ANSI.RESET);
      return;
    }

    console.log('\n' + ANSI.BOLD + 'SSE Chunks:' + ANSI.RESET);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let chunkCount = 0;
    let foundUsage = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            console.log(ANSI.DIM + '  [DONE]' + ANSI.RESET);
            continue;
          }

          chunkCount++;
          try {
            const json = JSON.parse(data);
            
            // Check if this is the usage chunk (choices: [] and usage present)
            if (json.usage && Array.isArray(json.choices) && json.choices.length === 0) {
              console.log('\n' + ANSI.GREEN + ANSI.BOLD + '  ✓ USAGE CHUNK #' + chunkCount + ':' + ANSI.RESET);
              console.log('    ' + JSON.stringify(json, null, 2).split('\n').join('\n    '));
              foundUsage = true;
            } else if (json.choices && json.choices.length > 0) {
              // Content chunk
              const delta = json.choices[0]?.delta || {};
              const content = delta.content || '';
              const finishReason = json.choices[0]?.finish_reason;
              if (content) {
                process.stdout.write(ANSI.DIM + content + ANSI.RESET);
              }
              if (finishReason) {
                console.log('\n' + ANSI.DIM + '  [finish_reason: ' + finishReason + ']' + ANSI.RESET);
              }
            } else if (json.cost !== undefined) {
              console.log(ANSI.GREEN + '  ✓ COST CHUNK: ' + json.cost + ANSI.RESET);
            }
          } catch {
            console.log(ANSI.YELLOW + '  [parse error] ' + data + ANSI.RESET);
          }
        }
      }
    }

    if (!foundUsage) {
      console.log('\n' + ANSI.RED + ANSI.BOLD + '✗ NO USAGE CHUNK FOUND' + ANSI.RESET);
      console.log('Total chunks received: ' + chunkCount);
    }
  } catch (err) {
    console.log(ANSI.RED + 'ERROR: ' + (err instanceof Error ? err.message : String(err)) + ANSI.RESET);
  }
}

async function probeModels(key: KeyEntry): Promise<void> {
  console.log('\n' + ANSI.BOLD + ANSI.CYAN + '=== MODELS ENDPOINT ===' + ANSI.RESET);
  console.log('GET https://opencode.ai/zen/go/v1/models');

  try {
    const response = await fetch('https://opencode.ai/zen/go/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + key.key,
      },
    });

    console.log('\nStatus: ' + response.status);
    const body = await response.text();
    
    try {
      const json = JSON.parse(body);
      if (json.data && Array.isArray(json.data)) {
        console.log('Available models (' + json.data.length + '):');
        for (const model of json.data) {
          console.log('  - ' + model.id);
        }
      } else {
        console.log(JSON.stringify(json, null, 2));
      }
    } catch {
      console.log(body);
    }
  } catch (err) {
    console.log(ANSI.RED + 'ERROR: ' + (err instanceof Error ? err.message : String(err)) + ANSI.RESET);
  }
}

async function main(): Promise<void> {
  console.log(ANSI.BOLD + 'OpenCode-Go API Probe' + ANSI.RESET);
  console.log('Testing real API responses to validate usage data format\n');

  const keys = loadKeys('api_keys.txt');
  if (keys.length === 0) {
    console.error('No keys found in api_keys.txt');
    process.exit(1);
  }

  console.log('Found ' + keys.length + ' key(s):');
  for (const k of keys) {
    console.log('  - ' + k.label + ' (' + maskKey(k.key) + ')');
  }

  const key = keys[0]; // Use first key for testing

  await probeModels(key);
  await probeNonStreaming(key);
  await probeStreaming(key, false); // without stream_options
  await probeStreaming(key, true);  // with stream_options

  console.log('\n' + ANSI.BOLD + '=== SUMMARY ===' + ANSI.RESET);
  console.log('Check the output above to see:');
  console.log('  1. Does non-streaming response include usage field?');
  console.log('  2. Does streaming include a final usage chunk (without stream_options)?');
  console.log('  3. Does streaming include a final usage chunk (with stream_options)?');
  console.log('  4. What does the response structure look like?');
  console.log('  5. Are there any cost fields?');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
