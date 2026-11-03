FROM public.ecr.aws/lambda/microvms:al2023-minimal
RUN dnf install -y bash python3 git nodejs npm python3-pip docker iptables-nft tar gzip findutils procps-ng iproute bind-utils curl-minimal && dnf clean all
COPY agent.py /opt/camelrun/agent.py
WORKDIR /root
EXPOSE 8080
CMD ["python3", "/opt/camelrun/agent.py"]
