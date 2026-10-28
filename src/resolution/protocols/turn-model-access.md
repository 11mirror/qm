## Model access
An OpenAI-compatible model gateway is at `$MODEL_GATEWAY_URL` in the sandbox; authenticate with `Authorization: Bearer $MODEL_GATEWAY_TOKEN`. `GET $MODEL_GATEWAY_URL/v1/models` lists the usable models. The token is bound to this turn and expires with it; never send it anywhere but the gateway.
