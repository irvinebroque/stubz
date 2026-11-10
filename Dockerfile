FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY container/ .
RUN CGO_ENABLED=0 go build -o /supervisor .

FROM debian:bookworm-slim
COPY --from=build /supervisor /supervisor
EXPOSE 8080
ENTRYPOINT ["/supervisor"]
