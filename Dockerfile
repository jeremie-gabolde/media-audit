FROM python:3.11-slim

WORKDIR /app

# Set noninteractive to suppress debconf warnings
ENV DEBIAN_FRONTEND=noninteractive
ENV TERM=xterm

# Copy requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY . .

# Create data directory
RUN mkdir -p /app/data

# Reset to interactive for runtime
ENV DEBIAN_FRONTEND=dialog

# Run the Flask app
CMD ["python", "app.py"]

EXPOSE 8080