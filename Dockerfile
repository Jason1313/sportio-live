FROM node:24-alpine

# ffprobe, which ships in ffmpeg. It left the image once, when quality
# came entirely from published sweeps, and is back for the providers
# those sweeps cannot describe: a reseller like Flix-Streams renumbers
# every channel, so its streams are opened and measured instead. Only
# ever run when somebody asks to test a channel - see probe.js.
RUN apk add --no-cache ffmpeg

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

EXPOSE 2323

ENV PORT=2323
ENV HOST=0.0.0.0

CMD ["npm", "start"]
