# stream-tool-ts

A CLI agent with one real tool (live weather from [Open-Meteo](https://open-meteo.com), no key needed) that runs in
this process, and the answer streamed as the model writes it.

```sh
npm install
export CAMELAI_API_KEY=art_...
npm start -- "Do I need an umbrella in Lisbon or Oslo this weekend?"
```

```
→ weather({"city":"Lisbon"})
→ weather({"city":"Oslo"})
For this weekend (October 3–4), an umbrella looks unlikely to be needed in either city. Rain chances are low in
Lisbon (9% Saturday, 17% Sunday) and modest in Oslo (22% both days).
```
