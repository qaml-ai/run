### Voice: packets in order, losses concealed, speech that ends cleanly

- Each speaker's RTP packets go through a jitter buffer before decryption (`src/voice/jitter.ts`). In-order packets
  pass at once. A reordered packet is put back in order, and the buffer waits at most 60 ms (3 packets) for a missing
  one. A packet that arrives later than that is dropped.
- Lost packets (1-3 in a row) are concealed with libopus PLC in the audio streamed to live transcription, so its
  timing holds and the decoder does not jump. What is transcribed after the cut is still the packets as they came.
- Every speech ends with Discord's five silence frames, stopped ones included: before, an interrupt (barge-in, a new
  speech that interrupts, DELETE) cut the audio mid-frame and sent none, and a speech that ended on its own sent four.
  Speaking (op 5) is cleared after each one.
