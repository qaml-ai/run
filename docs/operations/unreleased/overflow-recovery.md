### Runtime

Pi compacts once when a model rejects a turn for exceeding its context window. If the retried request still overflows,
the turn now fails with the provider's overflow error. Later turns use the learned smaller window. The runtime no
longer retracts that final failure to compact and retry a second time.
