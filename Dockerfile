FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173 DATABASE_PATH=/data/attendance.sqlite DEV_LOGIN=false
EXPOSE 4173
USER node
CMD ["npm", "start"]
