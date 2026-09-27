# Civic Voice - Project Overview

## Project Summary

Civic Voice is a public sentiment and accountability platform for Indian citizens. It allows people to share how satisfied or dissatisfied they are with government laws, policy decisions, and reforms. The platform also helps citizens understand how tax money is collected and where it is being used, making government spending more visible and accountable.

The product is designed to combine two ideas:
- public opinion tracking, similar to a Mood of India style sentiment platform
- public accountability and transparency, similar to RTI-style information access

The goal is to help citizens, researchers, and policymakers understand public sentiment, tax utilization, and policy impact using demographic segmentation.

## Core Idea

The platform enables users to:
- rate how happy or unhappy they are with a new law or policy
- leave comments or feedback about government decisions
- review how the government collects taxes across different categories
- see where tax revenue is allocated and spent
- understand public sentiment by background, region, profession, age, and income level

This creates a civic data platform for sentiment analysis and financial transparency.

## Primary Features

### 1. Policy / Law Sentiment Tracking
- Users can rate a government decision or policy on a scale such as 1-10
- Users can express whether they feel positive, neutral, or negative about a law
- Users can add comments describing how a decision affects them
- The system aggregates these ratings into sentiment reports

### 2. Tax Collection & Utilization Dashboard
- Show how much the government collects in taxes across categories such as:
  - Income Tax
  - GST
  - Customs Duty
  - Corporate Tax
  - Excise Duty
  - Other statutory levies
- Show how tax money is allocated across sectors such as:
  - Infrastructure
  - Healthcare
  - Education
  - Defense
  - Rural development
  - Subsidies and welfare
- Help users visualize the gap between tax collection and public spending

### 3. RTI-Inspired Transparency Layer
- Provide citizens with structured access to public information related to policies, budgets, and decisions
- Make government data easier to consume and understand
- Link policy sentiment with underlying public data, accountability records, and spending information

### 4. Demographic Metrics for Reporting
Users can answer questions about:
- Age group
- Gender
- State/region
- Urban/Rural background
- Occupation/profession
- Income bracket
- Education level
- Employment status

These demographic traits are used as metrics in reports and dashboards so the platform can answer questions like:
- Which categories of people support a policy?
- Are urban vs rural citizens feeling differently about a law?
- Which income groups are most unhappy with tax utilization?
- How do different professions feel about a government decision?

## Target Users

- Citizens who want to express their opinions on policy decisions
- Researchers and journalists analyzing public sentiment
- Students studying democracy, public policy, and civic participation
- Government or policy departments seeking public feedback
- NGOs and civic organizations tracking public mood and accountability

## Business / Product Goal

Create an application that combines:
- civic participation
- government accountability
- sentiment analysis
- public data transparency

The platform should help turn public voice into structured, reportable data that can be segmented by demographic metrics and used to understand public sentiment toward governance.

## Suggested Functional Modules

### Frontend (React)
- Landing page / public portal
- Policy listing pages
- Sentiment rating forms
- Tax and budget dashboard
- Analytics charts
- Responsive mobile-friendly UI
- User profile with demographic questionnaire

### Backend (Java Spring Boot)
- User authentication and profile management
- Policy and law management APIs
- Sentiment submission APIs
- Tax collection and spending data APIs
- Demographic analytics APIs
- Reporting and dashboard endpoints

### Database
- Users
- Policies
- Sentiment records
- Tax data records
- Government spending records
- Demographic metadata
- Reports and analytics tables

## Example Use Cases

- A citizen rates a new education policy and leaves a comment
- The platform aggregates 10,000 ratings and shows sentiment by age group and state
- A user checks how much tax was collected and which departments received funding
- A civic researcher compares public sentiment against budget allocation by sector
- An NGO identifies if a policy is generating strong dissatisfaction among rural or lower-income groups

## Product Philosophy

The app should be:
- transparent
- citizen-first
- data-driven
- easy to understand
- mobile and web friendly
- built around public trust and accountability

## What Makes This Different

This project is not just a survey app. It combines:
- public voice
- policy monitoring
- accountability reporting
- spending transparency
- demographic analytics

It is closer to a civic intelligence platform than a simple opinion poll.

## Initial MVP Scope

The first version should include:
- user sign-up and login
- user demographic profile
- policy listing
- sentiment input form
- basic analytics dashboard
- tax collection summary page
- responsive frontend and backend setup

## Long-Term Vision

Build a scalable civic platform that can:
- track sentiment across many government policies
- provide transparent tax and budget insights
- support public discourse around governance
- generate actionable insights using demographic segmentation
- become a trusted civic data platform in the public domain

## Project Positioning

This project is a blend of:
- RTI transparency
- Mood of India public sentiment tracking
- public policy reporting
- tax transparency and accountability

It is essentially a civic-tech platform for policy sentiment and public financial visibility.

## Success Criteria

The project is successful if it can:
- collect meaningful public sentiment on policies
- present clear financial transparency around taxes and spending
- enable demographics-based reporting
- help users understand how public perception shifts by group and region
- create a trusted source of civic data for reporting and analysis
