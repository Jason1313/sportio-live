FROM node:24-alpine

# ffprobe (part of ffmpeg) reads the resolution and frame rate of a live
# stream. Providers list several different feeds of a channel under one
# identical name - same name, same group, same tvg-id - so opening the
# stream is the only way to tell 1080p60 from 720p30. Used only when the
# user explicitly asks for it from the channel picker, never in bulk.
RUN apk add --no-cache ffmpeg

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

EXPOSE 2323

ENV PORT=2323
ENV HOST=0.0.0.0

CMD ["npm", "start"]
