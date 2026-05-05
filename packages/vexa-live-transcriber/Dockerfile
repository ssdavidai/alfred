FROM python:3.12-alpine
WORKDIR /app
RUN apk add --no-cache --virtual .build gcc musl-dev libffi-dev && \
    pip install --no-cache-dir --upgrade pip
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && \
    apk del .build
COPY worker.py .
CMD ["python", "-u", "worker.py"]
