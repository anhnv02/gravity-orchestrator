#!/bin/bash
# Gravity Orchestrator - Build Script
# Build and package VSCode extension

set -e

echo "======================================"
echo "Gravity Orchestrator Build"
echo "======================================"
echo ""

# Check Node.js
echo "[1/6] Checking Node.js..."
if command -v node &> /dev/null; then
    nodeVersion=$(node --version)
    echo "OK Node.js version: $nodeVersion"
else
    echo "ERROR: Node.js not found"
    exit 1
fi

# Check npm
echo "[2/6] Checking npm..."
if command -v npm &> /dev/null; then
    npmVersion=$(npm --version)
    echo "OK npm version: $npmVersion"
else
    echo "ERROR: npm not found"
    exit 1
fi

# Check dependencies
echo "[3/6] Checking dependencies..."
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        echo "ERROR: Failed to install dependencies"
        exit 1
    fi
fi
echo "OK Dependencies ready"

# Check vsce
echo "[4/6] Checking vsce..."
if command -v vsce &> /dev/null; then
    vsceVersion=$(vsce --version)
    echo "OK vsce version: $vsceVersion"
else
    echo "Installing vsce..."
    npm install -g @vscode/vsce
    if [ $? -ne 0 ]; then
        echo "ERROR: Failed to install vsce"
        exit 1
    fi
    echo "OK vsce installed"
fi

# Compile TypeScript
echo "[5/6] Compiling TypeScript..."
npm run compile
if [ $? -ne 0 ]; then
    echo "ERROR: Compilation failed"
    exit 1
fi
echo "OK Compilation successful"

# Package extension
echo "[6/6] Packaging extension..."
vsce package
if [ $? -ne 0 ]; then
    echo "ERROR: Packaging failed"
    exit 1
fi

echo ""
echo "======================================"
echo "BUILD SUCCESS!"
echo "======================================"

# Find generated .vsix file
latestVsix=$(ls -t *.vsix 2>/dev/null | head -n 1)
if [ -n "$latestVsix" ]; then
    fileSize=$(stat -f%z "$latestVsix" 2>/dev/null || stat -c%s "$latestVsix" 2>/dev/null)
    fileSizeKB=$(echo "scale=2; $fileSize / 1024" | bc)
    echo ""
    echo "Package: $latestVsix"
    echo "Size: ${fileSizeKB} KB"
    echo "Path: $(pwd)/$latestVsix"
fi
