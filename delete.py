import redis

r = redis.Redis(
    host='redis-14889.c277.us-east-1-3.ec2.cloud.redislabs.com',
    port=14889,
    password='cGySKpNCAFjUV8Ywf39u15Lac1byV8YR',
    username='default'
)

key = "games_v1"

result = r.delete(key)

print(f"Deleted count: {result}")
