FROM node:24-alpine

# No ffmpeg. Stream quality used to be measured here with ffprobe, which
# meant carrying the whole of ffmpeg to read two numbers off a video
# stream. It now comes from published sweeps instead - see streamcheck.js
# - so the image no longer needs it.

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

EXPOSE 2323

ENV PORT=2323
ENV HOST=0.0.0.0

CMD ["npm", "start"]
