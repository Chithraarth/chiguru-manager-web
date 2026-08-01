# syntax=docker/dockerfile:1

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* .npmrc ./
RUN npm install
COPY . .
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_APP_ID
ENV PORT=5174
ENV BASE_PATH=/manager/
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist/public /usr/share/nginx/html/manager
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
