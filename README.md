This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploying

The backend runs on **Porter** (AWS EKS) from one Docker image started four ways —
the web server, the import worker, and two cron sweeps. `porter.yaml` is the
deployment; **[docs/deployment.md](docs/deployment.md)** lists every production
environment variable, where it comes from, and which ones are needed at build time
rather than at runtime.

```bash
docker build -t bramble:local .          # builds with nothing configured
pnpm dev:all                             # Next dev server + import worker
pnpm worker                              # the worker alone
pnpm sweep:arc | pnpm sweep:imports      # a sweep on demand
```
