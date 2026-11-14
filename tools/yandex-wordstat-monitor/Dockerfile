FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py config.yaml ./
COPY src ./src
RUN useradd --uid 10001 --create-home appuser && chown -R appuser:appuser /app
USER 10001
CMD ["python", "main.py", "--dry-run"]
