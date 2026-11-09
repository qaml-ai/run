### Fix the Workers computer tool schema

The Cloudflare runtime now declares an explicit object root for the computer tool. This fixes provider requests rejected with an invalid tool schema while preserving operation-specific argument validation.
