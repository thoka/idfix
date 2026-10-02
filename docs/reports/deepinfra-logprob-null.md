# Bug report for DeepInfra: stream fails on a null logprob (GLM-5.3-Flash)

Draft for DeepInfra support. The user sends it with the DeepInfra account.

## Summary

Streaming chat completions for `zai-org/GLM-5.3-Flash` on the OpenAI-compatible endpoint fail in the middle of the stream. The response starts with HTTP 200. Then the stream ends with a validation error from your own server. We did not ask for log probabilities. About 1 in 25 requests fails this way.

## Error text

```
Exception: 1 validation error for OpenAIChatCompletionStreamOut choices.0.logprobs.content.0.logprob Input should be a valid number [type=float_type, input_value=None, input_type=NoneType]
```

## Request

- Endpoint: `POST https://api.deepinfra.com/v1/openai/chat/completions`
- Model: `zai-org/GLM-5.3-Flash`
- `stream: true`
- The request contains no `logprobs` and no `top_logprobs` parameter. The client is `@ai-sdk/openai-compatible` 3.0.62 inside opencode 1.18.32. Its source does not contain the string `logprob`.
- The requests are agent sessions with tool calls and long contexts.

## What happened

On 2026-10-01, two agent sessions stopped with this error:

1. A session failed on request 38 of 38, after 29 minutes.
2. A session failed on request 9 of 9, after 5 minutes.

In both cases our logging proxy recorded HTTP status 200 for the failed request, because the error came inside the stream.

Request ids: <ids of the failed requests on 2026-10-01, from the DeepInfra dashboard>

## Our analysis

The stream model `OpenAIChatCompletionStreamOut` declares `logprob` as a required float. For some token, the serving code fills `logprobs.content[0].logprob` with `null`, and the server then rejects its own chunk. The client never receives a valid chunk, so it cannot handle the case. We guess that the token is a special or reasoning token of GLM-5.3-Flash that has no log probability. The same class of bug was fixed in other projects, for example vLLM issue #46028 and SGLang PR #9368.

## Expected behavior

If the client does not ask for log probabilities, the stream chunks contain no `logprobs` object, or `logprobs: null`. If the server emits `logprob: null`, the schema allows it (`Optional[float]`).

## Impact

An agent run ends in the middle of its task, and the client does not retry an error after HTTP 200. For now we send these requests to other providers.

## Contact

Thomas Kalka, thomas.kalka@gmail.com
