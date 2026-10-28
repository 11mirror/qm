# Send scheduled QM messages back to the app where the user asked

We're connecting a chat app to QM. A user can send a prompt through that app and get QM's reply in the same conversation. The missing part is what happens later:

> Send me an update here every five minutes.

We want those updates to arrive in that conversation, even after the user closes their browser, with the app's normal notifications. This should also work for other proactive messages from QM.

Could QM push these messages directly to the host app? We'd prefer that to having the app poll QM's transcript.

The app could pass an opaque conversation reference when it forwards a turn, and a cron created from that turn would keep that destination. When the cron fires, QM would send the message to an operator-configured endpoint. The callback should be authenticated, survive a temporary outage or restart, and include a stable message ID so retries don't create duplicate messages. The receiving app would check that the user still has access to the conversation.

QM also needs the delivered update in its conversation history so the user's next question can refer to it. And the initial reply shouldn't appear twice if it arrives through both streaming and a callback.
