### Runtime

- OpenAI client-held voice calls take `interruptResponse: false`, so an app that runs its own echo guard owns barge-in while OpenAI keeps detecting turns and starting responses.
