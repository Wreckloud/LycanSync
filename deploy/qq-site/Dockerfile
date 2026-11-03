FROM eclipse-temurin:17-jre-noble
RUN groupadd --gid 10001 lycansync \
    && useradd --uid 10001 --gid 10001 --no-create-home lycansync \
    && mkdir -p /app /var/bootstrap /var/chat-files \
    && chown -R 10001:10001 /app /var/bootstrap /var/chat-files
WORKDIR /app
COPY --chown=10001:10001 api.jar /app/api.jar
USER 10001:10001
EXPOSE 18080
ENTRYPOINT ["java", "-jar", "/app/api.jar"]
