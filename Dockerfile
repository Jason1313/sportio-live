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

# npm ci installs exactly what the lockfile pins, so a rebuild never moved
# a dependency and the instance sat on whatever was current the day the
# lockfile was last written. update.sh rebuilds weekly, and this lets that
# rebuild take the newest release each ^ range allows (express stays on 4,
# axios on 1). The lockfile still decides the starting point; it just no
# longer freezes the result.
RUN npm update --omit=dev

COPY . .

EXPOSE 2323

ENV PORT=2323
ENV HOST=0.0.0.0

CMD ["npm", "start"]
